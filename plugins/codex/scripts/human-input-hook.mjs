#!/usr/bin/env node
import { humanInputHook } from "./lib/desktop-runtime/queued-human-input.mjs";

// No gateway, credential, workflow or filesystem lookup. Both native clients
// consume this additive context even when workflow enforcement is inactive.
process.stdout.write(`${JSON.stringify(humanInputHook())}\n`);
