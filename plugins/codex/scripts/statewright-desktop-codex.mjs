#!/usr/bin/env node

import { desktopProfileEnvironment, runDesktopAppServerBroker, startProfileDesktopMcpBridge } from "./lib/desktop-runtime/codex-desktop-app-server-launcher.mjs";
import { readDesktopState } from "./statewright-desktop-setup.mjs";

try {
  const state = await readDesktopState(process.env.STATEWRIGHT_DESKTOP_STATE_PATH);
  await runDesktopAppServerBroker({
    startMcpBridge: ({ environment }) => startProfileDesktopMcpBridge({ state, environment }),
    environment: {
      ...await desktopProfileEnvironment(state, process.env),
      STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: state.original_codex,
      STATEWRIGHT_DESKTOP_CLIENT_ID: state.client_id,
    },
  });
} catch (error) {
  process.stderr.write(`[statewright] Desktop broker refused to start: ${error.message}\n`);
  process.exitCode = 1;
}
