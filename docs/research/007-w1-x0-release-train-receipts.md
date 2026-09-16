# W1 hosted-Windows receipt and X0 desktop capability receipts

Date: 2026-09-16. Release-train evidence for the P0/W0/W1/W2, X0/X1, C1, D1, O1, P1 plan: the
W1 canary outcome on hosted Windows and the bounded X0 desktop discovery on the local macOS host
(`aerith.local`, macOS 15.3.1 arm64). Companion to 006 (control-plane host feasibility).

## W1: hosted-Windows authenticated-CLI feasibility (canary)

Run 35141883392 (revision 82f6397, trusted main push + manual dispatch; job `Windows plugin
canary`, `windows-2022`): **success**.

Version/launcher/spawn-strategy receipt from the run:

- codex `codex-tui/0.144.5 (Windows NT 10.0.26200)`, launcher
  `C:\ProgramData\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.cmd`,
  spawn strategy `s3_pwsh` (PowerShell profile).
- claude `2.1.185 (Claude Code)`, launcher
  `C:\Users\runneradmin\.local\bin\claude.exe` (symlink to the npm `cli.js`), spawn `s1_node`;
  installed launcher version 2.1.195.
- The new non-interactive CLI probe reports both vendors `not_provisioned` on this runner: the
  step-scoped credential secrets are not provisioned, so no authenticated turn executed and the
  job stayed green by contract.

Proven on native Windows: managed bootstrap, `.cmd`/node launcher execution through the managed
supervisor, deterministic route/restart cycle with quoted config, fresh PowerShell profile
activation, cmd.exe PATH activation, uninstall restoration, and non-interactive CLI launch with
version capture. Not proven: an authenticated vendor turn (no credentials on the hosted runner),
an interactive vendor session, or a Statewright-gated approval loop (needs an interactive runner
and human acceptance).

Barrier and contract (human-owned): the workflow step `Probe authenticated vendor CLI
feasibility` consumes step-scoped repository secrets
`STATEWRIGHT_CANARY_CODEX_AUTH_JSON` or `STATEWRIGHT_CANARY_OPENAI_API_KEY` (Codex) and
`STATEWRIGHT_CANARY_CLAUDE_OAUTH_TOKEN` or `STATEWRIGHT_CANARY_ANTHROPIC_API_KEY` (Claude).
Hosted runners cannot complete interactive logins, so provisioning at least one of these is the
only remaining step to convert W1 from `not_provisioned` to authenticated-turn evidence. A
provisioned vendor whose turn fails fails the job (actionable infeasibility evidence).

The prior W0 defect (npm lifecycle re-download plus `npm_config_loglevel`/`node_repl` crash)
remains fixed (d70438a) and green through 82f6397.

## X0: desktop capability receipts (local macOS host)

### ChatGPT.app (Codex desktop)

- `com.openai.codex` 26.818.31338, Chromium framework 151.0.7922.170; main process running
  ~14 days.
- Ownership: the app main process spawns its **own embedded app-server**
  (`ChatGPT.app/Contents/Resources/codex app-server -c features.code_mode_host=true`) as a child,
  plus Renderer/Service helpers. The app-side app-server exposes no local TCP listener; it
  communicates over unix sockets and the shared `~/.codex/ipc/ipc.sock`. Outbound: OpenAI
  (104.18.32.47:443) and local OTel (127.0.0.1:4318).
- Config/state ownership: shared `~/.codex` home with the installed CLI (config.toml/json,
  auth.json, hooks, plugins, process_manager, ipc, thread-writer-locks, session_index.jsonl).

### Installed codex CLI + shared session identity

- codex-cli 0.153.4 (npm/homebrew). `~/.codex/sessions` is the shared rollout store (~17 GB,
  year-partitioned `rollout-YYYY-*.jsonl` plus `session_index.jsonl`); the same naming and index
  identify sessions for both the desktop app and the CLI on this host.

### Statewright-managed app-server (live safe probe)

- A Statewright-managed supervisor instance of codex 0.151.0 runs with a private temporary
  CODEX_HOME (`statewright-swc_...-app-server-...`) and serves WS JSON-RPC on
  127.0.0.1:55140 (HTTP upgrade; newline-delimited JSON frames).
- Safe non-mutating probe executed: `initialize` round-trip succeeded (server returned
  userAgent/codexHome/platform result) and then the server pushed a server-originated
  `remoteControl/status/changed` notification (status disabled, serverName `aerith.local`,
  installationId 8348dbfa-3043-4910-8b55-01593550f5d3). The WS JSON-RPC app-server transport is
  automatable and already drives the local Statewright executor.

### Claude Desktop

- `com.anthropic.claudefordesktop` 1.5354.0 installed; not running at discovery time.
- App Support holds a Chromium profile only. No `claude_desktop_config.json` or MCP config files
  were found (searched to depth 3); the preferences plist contains only standard Cocoa UI keys.
- Receipt: MCP surface **unprovisioned** on this host. No Claude-desktop gate is asserted; X1
  gate selection for the Claude desktop surface is deferred until a provisioned host is
  identified.

### Context surface (D1-relevant, not a vendor desktop surface)

- A local-models stack (`codex-local-models`: python serve + `launch.mjs` with bypass flags,
  remote clients on ws://127.0.0.1:50445, listener on 127.0.0.1:58631) is live on this host. It
  is an existing local codex host relevant to the D1 deduplication scope, not part of X0 vendor
  discovery.

## X0 conclusion

Per-surface receipts are recorded without asserting gates, per the plan. Transport implication
for the next slice: the Codex side already has a proven, Statewright-managed WS JSON-RPC
app-server transport on this host; the Claude desktop side is not automatable here until MCP is
provisioned, so the C1/X1 transport decision must not bind the Claude desktop surface on this
host.
