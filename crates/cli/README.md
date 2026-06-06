# statewright-cli

State machine constrained LLM executor. Runs agent loops with guardrails against Ollama models.

Binary: `sw-agent`

## CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--task`, `-t` | `"Fix the failing test..."` | Task description for the agent |
| `--workdir`, `-w` | `crates/cli/fixtures/buggy-calc` | Working directory for the agent |
| `--model` | `qwen2.5-coder:32b` | Ollama model name |
| `--ollama-url` | `http://localhost:11434/v1` | Ollama API URL |
| `--state` | — | Execute a single state then exit (TUI orchestration mode) |
| `--json-events` | `false` | JSONL output to stdout for MCP gateway integration |
| `--config` | — | Run config JSON file (model routing, guardrails, workflow) |
| `--context-file` | — | Context JSON for single-state runs (recon results, prior tool output) |
| `--use-hardcoded-machine` | `false` | Skip state machine generation, use built-in machine |
| `--tool-mode` | `auto` | Tool calling mode: `native`, `raw`, or `auto` (tries native first) |
| `--control` | `false` | Single state, all tools, no guardrails (baseline comparison) |
| `--tdd` | `false` | TDD greenfield mode instead of bug-fix mode |
| `--tdd-chain` | `false` | TDD with debug machine chaining |
| `--max-steps` | `20` | Max total steps before giving up |
| `--max-cycles` | `10` | Max TDD cycles (only with `--tdd` or `--tdd-chain`) |
| `--model-size` | `20.0` | Model size in GB (capability gating: conversation retention, tool selection) |
| `--log` | `false` | Tee all output to `/tmp/statewright-<timestamp>.log` |

## Usage

Standalone run:

```bash
sw-agent --task "Fix failing tests" --workdir . --model gemma4:31b
```

Per-state execution (MCP orchestration — TUI runs one state at a time):

```bash
sw-agent --state implementing --json-events --workdir . --task "Add input validation"
```

Gateway-controlled (MCP proxy writes the config, agent reads it):

```bash
sw-agent --config /tmp/config.json --json-events
```

## Role

`sw-agent` is the execution backend invoked by the MCP proxy when `statewright_run_agent` is called from any TUI. The proxy writes a run config JSON, launches `sw-agent --config <path> --json-events`, and streams the JSONL events back to the client.

Apache 2.0.

[docs.statewright.ai](https://docs.statewright.ai) | [GitHub](https://github.com/statewright/statewright)
