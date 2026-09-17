#!/usr/bin/env node
import { Console } from "node:console";
import { runPiManagedCli } from "./src/request-main.mjs";

// Keep trusted project diagnostics out of native JSON/RPC stdout. SDK mode
// event/final output uses its own raw stdout writer, not console.log.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
try { process.exitCode = await runPiManagedCli(); }
catch { process.stderr.write("[statewright] Managed Pi startup failed; native delivery denied.\n"); process.exitCode = 1; }
