# Statewright Self-Hosted

Run the complete Statewright stack locally. BYO Ollama.

## Quick Start

```bash
cd self-hosted
docker compose up --build
```

Three services start:
- **UI** — http://localhost:8080 (workflow editor, run history, API keys)
- **PocketBase** — http://localhost:8090 (data store, API)
- **Gateway** — localhost:3001 (MCP proxy, state enforcement)

## Generate an API Key

1. Open http://localhost:8080/keys
2. Click **Generate Key**
3. Copy the key (shown once)

## Connect Your Agent

### Claude Code

Add to your MCP config (`.mcp.json` or settings):

```json
{
  "mcpServers": {
    "statewright": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### Codex

Add to `.codex/config.toml`:

```toml
[mcp_servers.statewright]
type = "sse"
url = "http://localhost:3001/sse"
headers = { Authorization = "Bearer YOUR_API_KEY" }
```

## BYO Ollama

This stack does **not** include Ollama. Install it separately:

```bash
# macOS/Linux
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull qwen2.5-coder:32b
```

Then configure your agent to use the self-hosted gateway with your Ollama instance.

## Architecture

```
Agent (Claude Code / Codex / Pi)
  ↓ MCP
Gateway (:3001) — enforces state machine transitions
  ↓ HTTP
PocketBase (:8090) — workflows, runs, logs, keys (SQLite)
  ↑ HTTP
UI (:8080) — workflow editor, run viewer
```

## Data

All data is stored in the `pb_data` Docker volume (SQLite). Back it up:

```bash
docker compose exec pocketbase cp -r /pb/pb_data /pb/backup
docker compose cp pocketbase:/pb/backup ./backup
```
