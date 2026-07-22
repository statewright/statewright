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
import { createHash } from "crypto";
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
function checkToolAllowed(toolName, cache, toolInput = {}) {
  if (toolName.startsWith("statewright_")) return { allowed: true };
  if (toolName.includes("statewright_")) return { allowed: true };
  if (SYSTEM_TOOLS.has(toolName)) return { allowed: true };
  if (cache.allowedTools.length === 0) return { allowed: true };
  if (cache.allowedTools.includes(toolName)) return { allowed: true };
  if (toolName === "apply_patch" && (cache.allowedTools.includes("Edit") || cache.allowedTools.includes("Write"))) {
    return { allowed: true };
  }
  if (toolName === "view_image" && cache.allowedTools.includes("Read")) {
    return { allowed: true };
  }
  if (isCodexShellTool(toolName) && typeof toolInput.command === "string" && cache.allowedTools.some((tool) => ["Read", "Grep", "Glob", "LS"].includes(tool)) && classifyReadOnlyShellCommand(toolInput.command).allowed) {
    return { allowed: true };
  }
  if (isCodexWebRun(toolName)) {
    const required = codexWebCapabilities(toolInput);
    if (required.length > 0 && required.every((capability) => cache.allowedTools.includes(capability))) {
      return { allowed: true };
    }
  }
  const transitions = cache.transitions.map((t) => t.event).join(", ");
  return {
    allowed: false,
    reason: `Tool '${toolName}' is not available in the '${cache.state}' phase. Allowed: ${cache.allowedTools.join(", ")}.${transitions ? ` To advance, use statewright_transition with: ${transitions}.` : ""}`
  };
}
function isCodexShellTool(toolName) {
  return toolName === "Bash" || toolName === "exec_command";
}
function isCodexWebRun(toolName) {
  return toolName.toLowerCase().replace(/[^a-z]/g, "").endsWith("webrun");
}
function codexWebCapabilities(toolInput) {
  const keys = new Set(Object.keys(toolInput));
  const required = /* @__PURE__ */ new Set();
  if (keys.has("search_query") || keys.has("image_query")) {
    required.add("WebSearch");
  }
  if (["open", "click", "find", "screenshot", "finance", "weather", "sports", "time"].some(
    (key) => keys.has(key)
  )) {
    required.add("WebFetch");
  }
  return [...required];
}
function classifyReadOnlyShellCommand(command) {
  const normalized = command.replace(/(?:^|\s)[012]?>\s*\/dev\/null\b/g, " ").replace(/(?:^|\s)2>&1\b/g, " ").trim();
  if (!normalized || /[\r\n<>`]|\$\(/.test(normalized)) {
    return { allowed: false, reason: "Command is not a read-only shell operation." };
  }
  const segments = normalized.split(/\s*(?:&&|\|\||;|\|)\s*/);
  if (segments.some((segment) => !isReadOnlyShellSegment(segment))) {
    return { allowed: false, reason: "Command is not a read-only shell operation." };
  }
  return { allowed: true };
}
function isReadOnlyShellSegment(segment) {
  const trimmed = segment.trim();
  if (!trimmed || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false;
  const commandMatch = trimmed.match(/^((?:\/[^\s]+\/)?[^\s]+)/);
  if (!commandMatch) return false;
  const executable = commandMatch[1].split("/").pop() ?? "";
  const args = trimmed.slice(commandMatch[1].length).trim();
  if ([
    "cat",
    "head",
    "tail",
    "grep",
    "fd",
    "ls",
    "pwd",
    "stat",
    "file",
    "wc",
    "cut",
    "tr",
    "jq",
    "du",
    "dirname",
    "basename",
    "realpath",
    "true",
    "false"
  ].includes(executable)) {
    return true;
  }
  if (executable === "sort") {
    return !/(?:^|\s)(?:-o|--output)(?:\s|=)/.test(args);
  }
  if (executable === "uniq") return true;
  if (executable === "rg") {
    return !/(?:^|\s)--pre(?:-glob)?(?:\s|=)/.test(args);
  }
  if (executable === "sed") {
    return /^-n\s+(['"]?)[0-9$]+(?:,[0-9$]+)?p\1(?:\s|$)/.test(args);
  }
  if (executable === "find") {
    return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0)(?:\s|$)/.test(args);
  }
  if (executable === "test" || executable === "[") return true;
  if (executable === "which") return true;
  if (executable === "command") return /^-v(?:\s|$)/.test(args);
  if (executable === "git") {
    const subcommand = args.match(/^(status|diff|log|show|rev-parse|ls-files|grep|describe)(?:\s|$)/);
    if (subcommand) return true;
    return /^branch(?:\s+(?:--show-current|--list))?\s*$/.test(args);
  }
  return false;
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
async function gwCall(gwUrl, apiKey, clientId, toolName, args = {}) {
  try {
    const resp = await fetch(`${gwUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Statewright-Client-Id": clientId
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
function resolveClientId(inputSessionId, env = process.env) {
  const material = env.STATEWRIGHT_CLIENT_ID ?? env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID ?? inputSessionId ?? `process:${process.ppid}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `swc_${digest}`;
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
  const raw = await gwCall(opts.gwUrl, opts.apiKey, opts.clientId, "statewright_get_state");
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
  const result = checkToolAllowed(toolName, cache, input.tool_input ?? {});
  if (!result.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason
      }
    };
  }
  if (isCodexShellTool(toolName) && input.tool_input?.command) {
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
  try {
    if (isActive(opts.sessionDir) && !toolName.includes("statewright_") && opts.apiKey) {
      const rawCache = readCache(opts.sessionDir);
      const runIdFile = join(opts.sessionDir, ".run_id");
      const seqFile = join(opts.sessionDir, ".log_seq");
      const runId = existsSync(runIdFile) ? readFileSync(runIdFile, "utf8").trim() : "";
      if (runId && rawCache) {
        const seq = existsSync(seqFile) ? parseInt(readFileSync(seqFile, "utf8").trim(), 10) + 1 : 1;
        writeFileSync(seqFile, String(seq));
        const phase = rawCache.state ?? "unknown";
        const toolOutput = typeof input.tool_result === "string" ? input.tool_result.slice(0, 102400) : JSON.stringify(input.tool_result ?? "").slice(0, 102400);
        const pbUrl = process.env.STATEWRIGHT_PB_URL ?? "https://statewright.ai";
        fetch(`${pbUrl}/api/collections/workflow_logs/records`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            phase,
            tool_name: toolName,
            tool_input: input.tool_input ?? {},
            tool_output: toolOutput,
            sequence: seq,
            duration_ms: 0,
            run_id: runId
          }),
          signal: AbortSignal.timeout(5e3)
        }).catch(() => {
        });
      }
    }
  } catch {
  }
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
          opts.clientId,
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
        opts.clientId,
        "statewright_get_state"
      );
      if (!raw) return null;
      writeCache(opts.sessionDir, raw);
      const cache = parseGatewayState(raw);
      if (raw.pending_approval) {
        const message = raw.pending_approval.message ?? "Human review required.";
        const external = raw.meta?.approval_mode === "external";
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: external ? "[statewright] Approval is pending on the configured external review channel. Do not continue this workflow until that reviewer resolves it." : `[statewright] REVIEW REQUIRED: ${message} Present this approval request to the user in the current UI. Do not continue the workflow until the user approves or rejects it.`
          }
        };
      }
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
          opts.clientId,
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
async function handleStop(_input, opts) {
  return null;
  if (!isActive(opts.sessionDir)) return null;
  let raw = readCache(opts.sessionDir);
  if (!raw && opts.apiKey) {
    raw = await gwCall(opts.gwUrl, opts.apiKey, opts.clientId, "statewright_get_state");
    if (raw) writeCache(opts.sessionDir, raw);
  }
  if (!raw?.state) return null;
  const cache = parseGatewayState(raw);
  if (cache.isFinal) {
    deactivate(opts.sessionDir);
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: `[statewright] Workflow complete. Final state: ${cache.state}. Enforcement deactivated.`
      }
    };
  }
  const continuation = `${formatStateContext(cache)} CONTINUATION REQUIRED: Codex attempted to stop while Statewright is still active in '${cache.state}'. Do not send a final response or wait for a new user prompt. Continue immediately with only the state-allowed tools, complete this phase, and call statewright_transition when its exit criteria are met.`;
  return {
    decision: "block",
    reason: `Statewright workflow is active in '${cache.state}'; continue until a final state.`,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: continuation
    }
  };
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
  const clientId = resolveClientId(input.session_id);
  const sessionKey = clientId.slice(4, 20);
  const sessionDir = join(swDir, "sessions", sessionKey);
  const opts = { apiKey, gwUrl, sessionDir, clientId };
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
      result = await handleStop(input, opts);
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
  classifyReadOnlyShellCommand,
  formatStateContext,
  handlePostTool,
  handlePreTool,
  handleStop,
  handleUserPrompt,
  resolveClientId
};
