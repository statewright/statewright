#!/usr/bin/env node
import { humanInputHook } from "./lib/desktop-runtime/queued-human-input.mjs";
import { NATIVE_STATEWRIGHT_GUIDANCE } from "./lib/desktop-runtime/native-statewright-guidance.mjs";

// No gateway, credential, workflow or filesystem lookup. Both native clients
// consume this additive context even when workflow enforcement is inactive.
const output = humanInputHook();
output.hookSpecificOutput.additionalContext += `\n\n${NATIVE_STATEWRIGHT_GUIDANCE}`;
process.stdout.write(`${JSON.stringify(output)}\n`);
