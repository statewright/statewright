#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapCodexOtelConfig } from "./lib/native-token-telemetry-config.mjs";

const result = await bootstrapCodexOtelConfig({
  projectDirectory: resolve(process.cwd()),
  codexConfigPath: process.env.CODEX_CONFIG_PATH ?? join(homedir(), ".codex", "config.toml"),
});
const { content: _content, ...safeResult } = result;
process.stdout.write(`${JSON.stringify(safeResult)}\n`);
process.exitCode = result.action === "conflict" ? 2 : 0;
