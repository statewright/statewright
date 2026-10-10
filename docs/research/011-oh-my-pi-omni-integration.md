# Oh My Pi (OMPI/ohmypi) integration discovery

> Public excerpt sanitized 2026-10-10; operational details omitted or generalized.
> Historical results below were not rerun for this documentation cleanup.

Status: O1 discovery complete; adapter design proposed, not yet built.
Discovered 2026-06-29 against local `ohmypi` CLI v18.0.11
(`~/.local/bin/omp`) and upstream `can1357/oh-my-pi` (git main,
docs at `https://github.com/can1357/oh-my-pi` — README, docs/cli.md,
docs/extensions.md, docs/hooks.md, docs/approval-mode.md, docs/rpc.md,
docs/extension-loading.md; snapshots in `<local-source-snapshot>/`).

## What the install is

- Node (Bun-compiled) single executable, 18.0.11, monorepo `@oh-my-pi/*`
  packages (pi-coding-agent, pi-ai, pi-tui, pi-tools, pi-mcp-adapter, ...).
- Config: `~/.omp/agent/settings.json` (JSON5), agent dir
  `~/.omp/agent` (profile- and `PI_CODING_AGENT_DIR`-aware).
- Sessions: JSONL transcripts at `~/.omp/agent/sessions/<cwd-encoded>/<ts>_<uuid>.jsonl`;
  per-session directories hold bash logs (`<ts>_<uuid>.<rand>_<hash>/`);
  internal URIs (`ompi://...`) serve sessions, plans, docs, tools; read with
  `omp read` (`-r <id-prefix>`, `-p <path>`, `-i` for internal URIs).
- Resume/fork: `--resume <id-prefix>`, `--continue`, `--session-path`, `--fork`;
  `/resume` UI with project + provider filtering.
- Tools: 6 built-in tools (read, bash, edit, write, bash_output, process),
  optional browser, eval, computer-use; 31 MCP tools from pi-mcp-adapter.
- Model registry: 458 provider/model entries, 1674 skills; default
  `anthropic/claude-opus-4-8` at max thinking.
- Plugins: `omp plugin install <spec>`, npm or git specs, user or project
  scope; plugin manager in settings UI.

## Live-verified integration surfaces (this machine)

| Surface | Evidence |
| --- | --- |
| ACP server (`omp acp`) | JSON-RPC 2.0 over stdio. `initialize` → `protocolVersion: 1`, `agentInfo: oh-my-pi 18.0.11`, auth via existing local credentials. `agentCapabilities: { loadSession: true, mcpCapabilities: {http, sse}, promptCapabilities: {embeddedContext, image} }`; `sessionCapabilities: { list, fork, resume, close }`. `session/new` returned `sessionId: <session-id>` plus `configOptions` including a Mode select (`default`, `plan` — read-only planning mode). Probes 2026-06-29. |
| RPC mode (`omp --mode rpc`) | Documented NDJSON protocol v1/v2 over stdio: ready frame, `response` correlation by `id`, session/agent events, `extension_ui_request` frames (methods `select`, `confirm`, `input`, `editor`, `cancel`) answered by `extension_ui_response`, host-tool and host-URI requests. Inbound commands include `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `bash` (+`abort_bash`), `set_model`, `compact`, `switch_session`, `branch`, `handoff`, `get_messages_page`. Bundled TypeScript and Python `RpcClient` classes ship in the npm packages and negotiate v2 chunked framing automatically. |
| Approval policy | Tiers `read`/`write`/`exec`; modes `always-ask` / `write` / `yolo` (**yolo is the default**; `--auto-approve`/`--yolo` force it). Per-tool user policy `tools.approval.<name>: allow|deny|prompt`; tool-declared `policy` and `override` safety prompts; `bash.patterns` deny/prompt/allow rules; unknown tools default to `exec` tier. In headless/RPC use, UI confirmations surface as `extension_ui_request` frames the host must answer. |
| Hooks / extensions | TS/JS default-export factory (`pi.on(...)` etc.). Tool interception: `tool_call` (pre; handler may `{block: true, reason}` or replace execution `input`), `tool_result` (post; may override content/details). Discovered from `<cwd>/.omp/hooks/pre|post/*.{ts,js}`, `<agentDir>/hooks/pre|post/`, `.omp/extensions/`, plugin entries, or `--extension`/`--hook` paths. Extensions additionally register tools, commands, renderers, and session injection (`sendMessage`, `appendEntry`). |
| Session read | `omp read` / `omp read -r <id-prefix>` / `omp read -i <ompi://uri>` return session content as a prompt/pipe. |

## Adapter design recommendation (O2)

1. **Transport: ACP (`omp acp`), not the private RPC mode.** ACP is a stable
   public protocol (JSON-RPC 2.0 over stdio), exposes `session/resume`,
   `session/fork`, `session/list`, `session/close` natively, and delivers
   permissions as first-class ACP `session/request_permission` requests with
   machine-readable option ids. The private RPC channel is richer (host tools,
   chunked frames, subagent frames) but is versioned against upstream
   internals; ACP keeps the adapter boundary stable. If RPC-specific features
   are later needed (e.g. `steer`, subagent progress), the bundled
   `RpcClient` from `@oh-my-pi/pi-coding-agent` is available to a Node-side
   adapter without re-implementing framing.
2. **Permission mapping.** The OMP adapter must run OMP out of `yolo`
   (e.g. approval mode `always-ask`, or rely on ACP permission prompts).
   Statewright's `session/request_permission` handler is the single decision
   point: render the ACP options through the canonical approval journal
   (owner = `ohmypi`, kind `tool_approval`, tool name + raw args + option ids
   in `requested_actions`), then answer with the chosen `optionId`.
   No in-agent hook is needed for the approval path in ACP mode; hooks remain
   the escape hatch for argument rewriting (`tool_call` input replacement)
   or hard policy blocks.
3. **Session identity.** ACP `sessionId` (ULID) plus the on-disk JSONL path
   under `~/.omp/agent/sessions/<cwd-encoded>/` give durable, resumable
   session identity for the P0 shared journal: record `sessionId` in the
   journal entry and resume with `session/resume {cwd, sessionId}`.
   Transcript reads for evidence use `omp read -r <prefix>` without
   re-prompting the model.
4. **Managed client shape.** Mirror the existing managed-client pattern:
   spawn `omp acp` as a child with stdio pipes, JSON-RPC id correlation,
   capability gate from `initialize` (require `sessionCapabilities.resume`
   for the standard workflow; degrade or refuse when absent), and a
   liveness/cleanup contract matching the W2 supervisor invariants
   (no orphaned child on failure paths, single-writer event log).
5. **Open items before building.** (a) Capture one real
   `session/request_permission` frame with its option shape from a
   non-yolo run; (b) confirm `session/load` vs `session/resume` semantics
   with `loadSession: true` for journal resume; (c) decide whether the
   adapter pins a CLI version and how version drift is detected
   (`initialize` advertises `agentInfo.version`); (d) provider credentials
   already live under `~/.omp` — the adapter must not copy or re-auth.

## Sources

- Upstream: `can1357/oh-my-pi` — README, `docs/cli.md`, `docs/extensions.md`,
  `docs/hooks.md`, `docs/approval-mode.md`, `docs/rpc.md`,
  `docs/extension-loading.md` (fetched 2026-06-29 to
  `<local-source-snapshot>/`).
- Local: `ohmypi` v18.0.11 at `~/.local/bin/omp`; `omp -v`;
  `~/.omp/agent/settings.json`; `~/.omp/agent/sessions/` layout; live ACP
  `initialize` + `session/new` probes (2026-06-29).
