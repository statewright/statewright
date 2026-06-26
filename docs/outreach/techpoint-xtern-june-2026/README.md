# TechPoint Xtern AI Workshop

Build an incident signal dashboard from a simulated security event firehose.

The starter app is intentionally incomplete. Your job is to use an AI coding agent, preferably with Statewright enabled, to make the tests pass and improve the dashboard without skipping the software delivery loop.

## Quickstart

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

## Suggested Agent Prompt

```text
Use Statewright.
First deactivate any active Statewright workflow.
Then activate the xtern-sdlc workflow. If xtern-sdlc is not available, create it from workflows/xtern-sdlc.json and load it.
After xtern-sdlc is active, read spec.md first.
Make npm test pass.
Then improve the Vue dashboard while preserving the API contract.
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
