# Statewright Self-Hosted

Full setup guide: [docs.statewright.ai/getting-started/self-hosted](https://docs.statewright.ai/getting-started/self-hosted)

## Quick Start

```bash
cd self-hosted
docker compose up --build
```

- **UI + PocketBase** — http://localhost:8090
- **Gateway** — localhost:3001

API key and `lspi` alias are printed to `docker compose logs` on first run. See the [full guide](https://docs.statewright.ai/getting-started/self-hosted) for agent config snippets and Ollama setup.
