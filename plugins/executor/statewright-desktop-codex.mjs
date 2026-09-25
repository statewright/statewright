#!/usr/bin/env node
import { runDesktopAppServerBroker } from "./lib/codex-desktop-app-server-launcher.mjs";

runDesktopAppServerBroker().catch(error => {
  process.stderr.write(`[statewright] Desktop broker refused to start: ${error.message}\n`);
  process.exitCode = 1;
});
