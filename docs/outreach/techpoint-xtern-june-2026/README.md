# TechPoint Xtern AI Workshop

Build an incident signal dashboard from a simulated security event firehose.

The starter app is intentionally incomplete. Your job is to use an AI coding agent, preferably with Statewright enabled, to make the tests pass and improve the dashboard without skipping the software delivery loop.

## Quickstart

Requirements:

- Node.js 20 or newer.
- Claude Code or Codex CLI if you want to use an agent.
- `tmux` only if you want the facilitator war-room TUI. The workshop can be completed without it.

```bash
npm test
npm start
```

Open <http://localhost:4317>.

For remote demos over VPN, bind the server to all interfaces:

```bash
HOST=0.0.0.0 PORT=4317 npm start
```

## Demo Scripts

```bash
npm run reset   # restore the red starter version
npm run gold    # apply the fixed reference solution
npm test        # unit + API tests
npm run e2e     # Playwright smoke test; run with npm start active
npm run demo    # BBS-style tmux orchestrator for live demos
```

For a fresh checkout, run `npm install` before `npm run e2e`.

## Install Statewright

Statewright is optional, but it is the point of the guarded-workflow version of this exercise.

In Claude Code:

```text
/plugin marketplace add statewright/statewright
/plugin install statewright
```

In Codex CLI:

```bash
codex plugin marketplace add statewright/statewright
codex plugin install statewright
```

The install flow opens a browser. Sign up at <https://statewright.ai>, generate an API key, and paste it when prompted.

After installation, use the prompt below. It tells the agent to deactivate any current workflow, load the workshop workflow, read the spec, and use tests as the gate.

## Suggested Agent Prompt

```text
Use Statewright.
First deactivate any active Statewright workflow.
Then activate the xtern-sdlc workflow. If xtern-sdlc is not available, create it from workflows/xtern-sdlc.json and load it.
After xtern-sdlc is active, read spec.md first.
Make npm test pass.
Then improve the Vue dashboard while preserving the API contract.
```

## Without tmux

You do not need `tmux` to do the exercise. Use ordinary terminal tabs or panes.

Terminal 1: run the broken starter app.

```bash
git clone https://github.com/statewright/statewright
cd statewright/docs/outreach/techpoint-xtern-june-2026
npm run reset
HOST=0.0.0.0 PORT=4317 npm start
```

Open <http://localhost:4317>. If you are connecting from another machine on VPN, use `http://<host-ip>:4317`.

Terminal 2: confirm the starter tests are red.

```bash
cd statewright/docs/outreach/techpoint-xtern-june-2026
npm test
```

Terminal 3: start your agent in the same directory, then paste the suggested prompt.

```bash
cd statewright/docs/outreach/techpoint-xtern-june-2026
claude
```

Or:

```bash
cd statewright/docs/outreach/techpoint-xtern-june-2026
codex
```

When the agent says it is done, rerun `npm test` in Terminal 2. For the browser smoke test, install Playwright first:

```bash
npm install
npm run e2e
```

## Files

- `spec.md` defines the required behavior.
- `data/security-events.ndjson` contains simulated firehose input.
- `src/backend/etl.mjs` is the main implementation target.
- `src/backend/server.mjs` exposes the API and serves the Vue UI.
- `public/app.js` contains the Vue dashboard.
- `workflows/xtern-sdlc.json` is a Statewright workflow for the exercise.
- `skills/security-firehose-dashboard/SKILL.md` is optional agent context.
- `versions/starter` and `versions/gold` are resettable overlays for live demos.

## Demo TUI

Run:

```bash
npm run demo
```

The TUI creates named dirty checkouts under `/tmp/xtern-ai-<name>`, resets them to the broken starter state, and launches full-size tmux windows for tests, server, Claude, and Codex.

Single-agent launches (`a` or `x`) reset and use the selected arena directly, so `t` tests the same checkout the agent just edited.

The war room (`w`) always resets the selected base arena and creates fresh dirty agent arenas:

- `/tmp/xtern-ai-<name>` for tests/server
- `/tmp/xtern-ai-<name>-claude` for Claude
- `/tmp/xtern-ai-<name>-codex` for Codex

War-room test windows are agent-specific, so Claude and Codex results do not get mixed.

Useful keys:

- `n`: create a new dirty arena.
- `r`: reset the selected arena to starter.
- `g`: apply the gold solution.
- `s`: launch the selected arena server on `0.0.0.0:4317`.
- `v`: launch a completed gold build on `0.0.0.0:4318`.
- `w`: open the full tmux war room.
- `a` / `x`: launch Claude or Codex against the selected arena.

Override demo bind settings with:

```bash
XTERN_DEMO_HOST=0.0.0.0 XTERN_DEMO_PORT=4317 XTERN_DEMO_GOLD_PORT=4318 npm run demo
```

Non-interactive setup:

```bash
node scripts/demo-tui.mjs create demo --force
node scripts/demo-tui.mjs path demo
node scripts/demo-tui.mjs preview demo
```

## Goal

Create useful incident signal from noisy events:

```text
events -> normalize -> score -> group -> API -> dashboard
```

The baseline is complete when `npm test` passes.
