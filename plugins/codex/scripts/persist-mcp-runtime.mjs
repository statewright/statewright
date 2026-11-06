#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { persistMcpRuntime } from "./statewright-desktop-setup.mjs";

// Runs before the shell reads any request. No credential/session discovery and
// no networking: preserve the exact selected package, not a newer cached one.
try {
  const stateRoot = join(homedir(), ".statewright");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const entry = await persistMcpRuntime({
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    statePath: join(stateRoot, "mcp-runtime.json"),
  });
  if (/[\r\n]/.test(entry)) throw new Error("Runtime path is not single-line");
  process.stdout.write(entry + "\n");
} catch (error) {
  // Do not echo arbitrary source content or inherited environment values.
  process.stderr.write("[statewright] MCP runtime snapshot could not be verified/published; no request forwarded.\n");
  process.exitCode = 1;
}
