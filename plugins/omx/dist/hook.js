// src/hook.ts
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { minimatch } from "minimatch";
var SYSTEM_TOOLS = /* @__PURE__ */ new Set([
  "TodoRead",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "TaskOutput",
  "Agent",
  "SendMessage",
  "AskUserQuestion",
  "ExitPlanMode",
  "ToolSearch",
  "Skill"
]);
function checkToolAllowed(toolName, cache) {
  if (toolName.startsWith("statewright_")) return { allowed: true };
  if (toolName.includes("statewright_")) return { allowed: true };
  if (SYSTEM_TOOLS.has(toolName)) return { allowed: true };
  if (cache.allowedTools.length === 0) return { allowed: true };
  if (cache.allowedTools.includes(toolName)) return { allowed: true };
  const transitions = cache.transitions.map((t) => t.event).join(", ");
  return {
    allowed: false,
    reason: `Tool '${toolName}' is not available in the '${cache.state}' phase. Allowed: ${cache.allowedTools.join(", ")}.${transitions ? ` To advance, use statewright_transition with: ${transitions}.` : ""}`
  };
}
function classifyBashCommand(command, cache) {
  const hasWrite = cache.allowedTools.includes("Write");
  const hasEdit = cache.allowedTools.includes("Edit");
  if (/^\s*(rm|rmdir|shred|truncate|unlink)\s/.test(command)) {
    return {
      allowed: false,
      reason: `Destructive operation not permitted in this phase.`
    };
  }
  if (/(&&|;)\s*(rm|rmdir|shred|truncate|unlink)\s/.test(command)) {
    return {
      allowed: false,
      reason: `Destructive operation not permitted in this phase.`
    };
  }
  if (!hasWrite && !hasEdit) {
    if (/([^0-9])?>([^>&])|>>\s*\S/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: output redirect detected but Write/Edit not in allowed tools for '${cache.state}' phase.`
      };
    }
    if (/sed\s+-i|perl\s+-p?i/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: in-place file modification detected but Edit not in allowed tools for '${cache.state}' phase.`
      };
    }
    if (/^\s*(python|python3|ruby|node|perl|php)\s/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: scripting interpreter not permitted without Write/Edit in '${cache.state}' phase.`
      };
    }
  }
  if (cache.allowedCommands.length > 0) {
    const ok = cache.allowedCommands.some(
      (prefix) => command === prefix || command.startsWith(prefix + " ")
    );
    if (!ok) {
      return {
        allowed: false,
        reason: `Bash command blocked: not in allowed commands for '${cache.state}' phase.`
      };
    }
  }
  if (cache.blockedEnv.length > 0) {
    for (const bvar of cache.blockedEnv) {
      const pattern = new RegExp(
        `\\$${bvar}|\\$\\{${bvar}\\}|^${bvar}=| ${bvar}=`
      );
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Bash command blocked: references restricted env var in this phase.`
        };
      }
    }
  }
  return { allowed: true };
}
function formatStateContext(cache) {
  const transitions = cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ");
  const lines = [
    `Statewright workflow active. AUTONOMOUS MODE: work continuously through each state -- use tools, complete the work, transition, and keep going. Do NOT stop or ask the user between states. Only pause at approval gates or final states.`,
    `Phase: ${cache.state} (iteration ${cache.iteration}/${cache.maxIterations ?? "none"}).`,
    `Tools: ${cache.allowedTools.join(", ")}.`,
    `Transitions: ${transitions}.`,
    `MANDATORY: Every statewright_transition call MUST include data.rationale.`
  ];
  if (cache.instructions) lines.push(`Instructions: ${cache.instructions}`);
  if (cache.interruptReturn)
    lines.push(`IN INTERRUPT HANDLER. Return to: ${cache.interruptReturn}`);
  if (cache.fork?.active)
    lines.push(`FORK active. Branch: ${cache.fork.currentBranch}`);
  return lines.join(" ");
}
function checkInterrupts(filePath, interrupts, interruptReturn) {
  if (!filePath || Object.keys(interrupts).length === 0) return null;
  if (interruptReturn) return null;
  for (const [name, def] of Object.entries(interrupts)) {
    if (minimatch(filePath, def.file_pattern, { matchBase: true }) || minimatch(filePath, `**/${def.file_pattern}`, { dot: true })) {
      return name;
    }
  }
  return null;
}
async function gwCall(gwUrl, apiKey, toolName, args = {}) {
  try {
    const resp = await fetch(`${gwUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args }
      }),
      signal: AbortSignal.timeout(8e3)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
function parseGatewayState(raw) {
  return {
    state: raw.state,
    isFinal: raw.is_final ?? false,
    iteration: raw.iteration ?? 0,
    maxIterations: raw.max_iterations ?? null,
    allowedTools: raw.allowed_tools ?? [],
    instructions: raw.instructions ?? null,
    transitions: raw.transitions ?? [],
    context: raw.context ?? {},
    interrupts: raw.interrupts ?? {},
    allowedCommands: raw.allowed_commands ?? [],
    blockedEnv: raw.blocked_env ?? [],
    interruptReturn: raw.context?._interrupt_return ?? void 0,
    fork: raw.fork ? {
      active: raw.fork.active,
      currentBranch: raw.fork.current_branch,
      branches: raw.fork.branches
    } : void 0
  };
}
function readCache(sessionDir) {
  const cacheFile = join(sessionDir, ".state_cache");
  if (!existsSync(cacheFile)) return null;
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return null;
  }
}
function writeCache(sessionDir, state) {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, ".state_cache"), JSON.stringify(state));
}
function isActive(sessionDir) {
  return existsSync(join(sessionDir, ".active"));
}
function activate(sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, ".active"),
    JSON.stringify({ activated: (/* @__PURE__ */ new Date()).toISOString() })
  );
}
function deactivate(sessionDir) {
  const files = [
    ".active",
    ".state_cache",
    ".session_hinted",
    ".discovered_commands",
    ".capture_enabled",
    ".run_id",
    ".log_seq"
  ];
  for (const f of files) {
    try {
      unlinkSync(join(sessionDir, f));
    } catch {
    }
  }
}
async function handleUserPrompt(input, opts) {
  if (!opts.apiKey) {
    const prompt = input.prompt ?? "";
    const match = prompt.match(/sw_live_[a-zA-Z0-9_-]+/);
    if (match) {
      const keyDir = join(homedir(), ".statewright");
      mkdirSync(keyDir, { recursive: true });
      writeFileSync(join(keyDir, "api_key"), match[0], { mode: 384 });
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Statewright API key saved automatically. The user can now activate a workflow with: statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows."
        }
      };
    }
    return {
      decision: "block",
      reason: "Statewright plugin needs an API key. Visit https://statewright.ai/keys to sign up and generate one, then paste it here."
    };
  }
  if (!isActive(opts.sessionDir)) {
    const hintFile = join(opts.sessionDir, ".session_hinted");
    if (existsSync(hintFile)) return null;
    mkdirSync(opts.sessionDir, { recursive: true });
    writeFileSync(hintFile, "");
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Statewright plugin active. No workflow running. To start one, use statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows."
      }
    };
  }
  const raw = await gwCall(opts.gwUrl, opts.apiKey, "statewright_get_state");
  if (!raw?.state) {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Statewright gateway unreachable. Running without workflow enforcement this turn."
      }
    };
  }
  if (raw.is_final) {
    deactivate(opts.sessionDir);
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `[statewright] Workflow complete. Final state: ${raw.state}. Enforcement deactivated.`
      }
    };
  }
  writeCache(opts.sessionDir, raw);
  const cache = parseGatewayState(raw);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatStateContext(cache)
    }
  };
}
async function handlePreTool(input, opts) {
  if (!isActive(opts.sessionDir)) return null;
  const toolName = input.tool_name ?? "";
  if (toolName.includes("statewright_")) return null;
  if (SYSTEM_TOOLS.has(toolName)) return null;
  const raw = readCache(opts.sessionDir);
  if (!raw) return null;
  const cache = parseGatewayState(raw);
  if (cache.allowedTools.length === 0) return null;
  const result = checkToolAllowed(toolName, cache);
  if (!result.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason
      }
    };
  }
  if (toolName === "Bash" && input.tool_input?.command) {
    const bashResult = classifyBashCommand(
      input.tool_input.command,
      cache
    );
    if (!bashResult.allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: bashResult.reason
        }
      };
    }
  }
  return null;
}
async function handlePostTool(input, opts) {
  const toolName = input.tool_name ?? "";
  let swAction = "";
  if (/statewright_start|statewright_load_workflow/.test(toolName))
    swAction = "start";
  else if (/statewright_stop|statewright_deactivate|statewright_pause/.test(toolName))
    swAction = "stop";
  else if (/statewright_transition|statewright_force_state/.test(toolName))
    swAction = "transition";
  else if (/statewright_get_state/.test(toolName)) swAction = "refresh_cache";
  if (!swAction && isActive(opts.sessionDir)) {
    const rawCache = readCache(opts.sessionDir);
    if (rawCache) {
      const cache = parseGatewayState(rawCache);
      const isFileEdit = [
        "Edit",
        "Write",
        "MultiEdit",
        "apply_patch",
        "edit_file",
        "write_file",
        "create_or_update_file"
      ].includes(toolName);
      if (isFileEdit) {
        const filePath = input.tool_input?.file_path ?? input.tool_input?.path ?? input.tool_input?.file ?? "";
        if (filePath && Object.keys(cache.interrupts).length > 0) {
          const matched = checkInterrupts(
            filePath,
            cache.interrupts,
            cache.interruptReturn
          );
          if (matched) {
            const target = cache.interrupts[matched].target;
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: `[statewright] INTERRUPT: file '${filePath}' matched interrupt '${matched}'. You MUST immediately call statewright_transition(event='INTERRUPT:${matched}', data={'rationale': 'File edit triggered interrupt', 'trigger_file': '${filePath}'}) before doing anything else. This will transition to '${target}' for validation.`
              }
            };
          }
        }
      }
    }
    return null;
  }
  switch (swAction) {
    case "start": {
      activate(opts.sessionDir);
      if (opts.apiKey) {
        const raw = await gwCall(
          opts.gwUrl,
          opts.apiKey,
          "statewright_get_state"
        );
        if (raw) {
          writeCache(opts.sessionDir, raw);
          const cache = parseGatewayState(raw);
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `[statewright] Workflow loaded. Phase: ${cache.state}. Tools: ${cache.allowedTools.join(", ")}. Transitions: ${cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ")}. KEEP WORKING -- begin the ${cache.state} phase immediately. Do not stop or summarize.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`
            }
          };
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "[statewright] Workflow loaded."
        }
      };
    }
    case "stop": {
      deactivate(opts.sessionDir);
      return null;
    }
    case "transition": {
      const prevRaw = readCache(opts.sessionDir);
      const prevState = prevRaw?.state ?? "";
      let parsedResult = {};
      if (input.tool_response) {
        try {
          const arr = JSON.parse(input.tool_response);
          if (Array.isArray(arr) && arr[0]?.text) {
            parsedResult = JSON.parse(arr[0].text);
          } else if (typeof arr === "object") {
            parsedResult = arr;
          }
        } catch {
        }
      }
      const isForked = parsedResult.forked === true;
      const isJoined = parsedResult.joined === true;
      const branchDone = parsedResult.branch_completed;
      if (!opts.apiKey) return null;
      const raw = await gwCall(
        opts.gwUrl,
        opts.apiKey,
        "statewright_get_state"
      );
      if (!raw) return null;
      writeCache(opts.sessionDir, raw);
      const cache = parseGatewayState(raw);
      if (isForked) {
        const branches = parsedResult.branches;
        const branchNames = Object.keys(branches ?? {});
        const count = branchNames.length;
        const current = parsedResult.current_branch;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] FORK: ${count} branches [${branchNames.join(", ")}]. For parallel: spawn ${count} fork-branch-worker agents (one per branch), then WAIT for all ${count} task-notification events before proceeding. For sequential: work branch '${current}' first.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`
          }
        };
      }
      if (isJoined) {
        const joinTo = parsedResult.to;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] FORK JOIN complete. All branches done. Now in ${joinTo}. Tools: ${cache.allowedTools.join(", ")}. Transitions: ${cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ")}.`
          }
        };
      }
      if (branchDone) {
        const nextBranch = parsedResult.next_branch;
        const remaining = parsedResult.remaining;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] Branch '${branchDone}' done. ${remaining} remaining. Now working branch '${nextBranch}' (state: ${cache.state}). Tools: ${cache.allowedTools.join(", ")}.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`
          }
        };
      }
      if (cache.isFinal) {
        deactivate(opts.sessionDir);
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] ${prevState} => ${cache.state} (workflow complete, enforcement deactivated)`
          }
        };
      }
      const transStr = cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ");
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `[statewright] ${prevState ? `${prevState} => ` : ""}${cache.state}. Tools: ${cache.allowedTools.join(", ")}. Next transitions: ${transStr}. KEEP WORKING -- do not stop or wait for user input.`
        }
      };
    }
    case "refresh_cache": {
      if (isActive(opts.sessionDir) && opts.apiKey) {
        const raw = await gwCall(
          opts.gwUrl,
          opts.apiKey,
          "statewright_get_state"
        );
        if (raw) writeCache(opts.sessionDir, raw);
      }
      return null;
    }
    default:
      return null;
  }
}
async function handleStop() {
  return null;
}
async function main() {
  const endpoint = process.argv[2] ?? "user-prompt";
  let inputStr = "";
  for await (const chunk of process.stdin) {
    inputStr += chunk.toString();
  }
  const input = inputStr ? JSON.parse(inputStr) : {};
  const swDir = join(homedir(), ".statewright");
  let apiKey = process.env.STATEWRIGHT_API_KEY ?? null;
  if (!apiKey) {
    try {
      apiKey = readFileSync(join(swDir, "api_key"), "utf8").trim();
    } catch {
      apiKey = null;
    }
  }
  const gwUrl = process.env.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai";
  const sessionKey = (input.session_id ?? process.env.CODEX_SESSION_ID ?? "default").slice(0, 12);
  const sessionDir = join(swDir, "sessions", sessionKey);
  const opts = { apiKey, gwUrl, sessionDir };
  let result = null;
  switch (endpoint) {
    case "user-prompt":
      result = await handleUserPrompt(input, opts);
      break;
    case "pre-tool":
      result = await handlePreTool(input, opts);
      break;
    case "post-tool":
      result = await handlePostTool(input, opts);
      break;
    case "stop":
      result = await handleStop();
      break;
  }
  if (result) {
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}
var isMainModule = typeof process !== "undefined" && process.argv[1] && (process.argv[1].endsWith("/hook.js") || process.argv[1].endsWith("/hook.ts"));
if (isMainModule) {
  main().catch((err) => {
    console.error("[statewright] hook error:", err);
    process.exit(0);
  });
}
export {
  checkInterrupts,
  checkToolAllowed,
  classifyBashCommand,
  formatStateContext,
  handlePostTool,
  handlePreTool,
  handleStop,
  handleUserPrompt
};
