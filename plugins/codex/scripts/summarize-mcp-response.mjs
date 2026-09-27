#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { summarizeStatewrightMcpResponse } from "./lib/desktop-runtime/statewright-tool-summary.mjs";

const tool = process.argv[2] ?? "";
const raw = readFileSync(0, "utf8");

try {
  process.stdout.write(JSON.stringify(summarizeStatewrightMcpResponse(tool, JSON.parse(raw))));
} catch {
  process.stdout.write(raw);
}
