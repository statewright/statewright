# Statewright Self-Hosted

Full setup guide: [docs.statewright.ai/self-hosted](https://docs.statewright.ai/self-hosted)

## Quick Start

```bash
cd self-hosted
docker compose up --build
```

- **UI** — http://localhost:8080
- **PocketBase** — http://localhost:8090
- **Gateway** — localhost:3001

Generate an API key at http://localhost:8080/keys, then connect your agent. See the [full guide](https://docs.statewright.ai/self-hosted) for agent config snippets and Ollama setup.
