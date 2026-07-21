# statewright-codex

State machine guardrails for [OpenAI Codex CLI](https://github.com/openai/codex). Per-state tool enforcement, interrupts, fork/join, approval gates.

## Install

```bash
codex plugin marketplace add statewright/statewright
codex plugin install statewright
```

Or manual setup:

1. Get an API key at [statewright.ai/keys](https://statewright.ai/keys)
2. Save it: `echo 'sw_live_...' > ~/.statewright/api_key`
3. Add the MCP server:
   ```bash
   codex mcp add statewright -- bash /path/to/plugins/codex/mcp-proxy.sh
   ```
4. Enable hooks in `~/.codex/config.toml`:
   ```toml
   [features]
   hooks = true
   ```
5. Merge `hooks.json` into `~/.codex/hooks.json`

**Important**: Add `env_vars` to propagate API keys to the MCP server:

```toml
[mcp_servers.statewright]
command = "bash"
args = ["/path/to/mcp-proxy.sh"]
env_vars = ["STATEWRIGHT_API_KEY", "STATEWRIGHT_GATEWAY_URL"]
```

Codex does not propagate parent environment variables to MCP child processes by default. The `env_vars` field explicitly forwards them.

## Usage

Start a workflow via MCP tool:

```
statewright_load_workflow(name='bugfix')
statewright_list_workflows()
```

`statewright_search_references(query)` is a local, read-only companion to
`statewright_search_docs`. It incrementally maintains a lexical index below Git
metadata for allowlisted guidance, workflows, code, and bounded evidence plus
recent commits. Results include path/line, source class, source hash, commit,
and rank reasons. Ignored files, generated folders, secret paths, and detected
credential material are excluded; repository contents never reach the gateway.

## Hook events

- **UserPromptSubmit**: injects workflow state, tools, instructions, autonomous mode directive
- **PreToolUse**: enforces allowed_tools per state, bash discernment, command whitelisting
- **PostToolUse**: interrupt detection (file pattern matching), fork/join status, capture
- **Stop**: blocks Codex from yielding while an active workflow is nonfinal and
  permits it only after a final state.

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
