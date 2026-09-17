import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const EXECUTOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

export async function prepareHostSession(options, fallbackId, execute = execFileAsync) {
  if (options.resumeWorkflow) return fallbackId;
  if (options.host !== "cursor") return fallbackId;
  let stdout;
  try {
    ({ stdout } = await execute(
      options.hostBin ?? "cursor-agent",
      ["create-chat"],
      { cwd: options.cwd, env: options.environment, encoding: "utf8" },
    ));
  } catch (error) {
    // Cursor can create and print the chat successfully before a later
    // Keychain lookup makes the command exit nonzero. The printed ID remains
    // the authoritative result and is validated below.
    stdout = error?.stdout;
    if (!stdout) throw error;
  }
  const sessionId = String(stdout).trim().split(/\s+/).at(-1) ?? "";
  if (!sessionId || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error("Cursor did not return a usable chat ID from create-chat.");
  }
  return sessionId;
}

export function assertHostOwnershipArgs(options) {
  const flags = new Set(["--session", "--session-id", "--session-dir", "--resume", "--continue", "--fork", "--fork-session", "--no-session"]);
  if (options.host === "pi" || options.host === "claude") { flags.add("-r"); flags.add("-c"); }
  for (const arg of options.hostArgs ?? []) {
    if (flags.has(arg.split("=")[0])) throw new Error("Executor owns native-session selection; conflicting host argument denied");
  }
}

/** Create only a new private Pi session using its installed public SDK. */
export async function createPiNativeSession({ pluginsRoot, cwd, sessionDir, sessionId }) {
  const { createPiSessionDescriptor } = await import(pathToFileURL(join(pluginsRoot, "pi", "session-owner.mjs")).href);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const { sessionFile, header } = createPiSessionDescriptor({ cwd, sessionDir, sessionId });
  if (header?.id !== sessionId || header.cwd !== cwd || header.type !== "session") throw new Error("Pi SDK returned a foreign native session");
  const file = await open(sessionFile, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(header) + "\n"); await file.sync(); } finally { await file.close(); }
  if (process.platform !== "win32") {
    const directory = await open(sessionDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  return sessionFile;
}

/** Pi silently recreates invalid sessions. Refuse that before CLI launch. */
export async function assertPiNativeSession({ sessionFile, sessionId, cwd }) {
  if (!sessionFile) throw new Error("Pi native session ownership is incomplete; recovery required");
  const info = await lstat(sessionFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid Pi native session file; resume denied");
  const file = await open(sessionFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid Pi native session file; resume denied");
    const text = await file.readFile("utf8");
    if (!text.endsWith("\n")) throw new Error("Incomplete Pi native session JSONL; resume denied");
    const end = text.indexOf("\n");
    if (end < 0) throw new Error("Invalid Pi native session header; resume denied");
    const header = JSON.parse(text.slice(0, end));
    if (header?.type !== "session" || header.version !== 3 || header.id !== sessionId || header.cwd !== cwd) {
      throw new Error("Foreign or unsupported Pi native session header; resume denied");
    }
    const entries = new Map();
    // The SDK skips malformed JSONL records. Do not silently lose history.
    for (const line of text.slice(end + 1).split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      // Pi 0.73 appends its identical bootstrap header at first assistant flush.
      // This is SDK-produced history, not permission to adopt a foreign header.
      if (entry?.type === "session" && isDeepStrictEqual(entry, header)) continue;
      if (!validPiEntry(entry)) {
        throw new Error("Invalid Pi native session history; resume denied");
      }
      if (entries.has(entry.id) && !isDeepStrictEqual(entries.get(entry.id), entry)
        || entry.parentId !== null && !entries.has(entry.parentId)) {
        throw new Error("Invalid Pi native session ancestry; resume denied");
      }
      if (entry.type === "compaction") {
        let cursor = entry.parentId;
        while (cursor !== null && cursor !== entry.firstKeptEntryId) cursor = entries.get(cursor).parentId;
        if (cursor === null) throw new Error("Invalid Pi compaction boundary; resume denied");
      }
      if (entry.type === "label" && !entries.has(entry.targetId)) {
        throw new Error("Invalid Pi native label reference; resume denied");
      }
      entries.set(entry.id, entry);
    }
  } finally { await file.close(); }
}

function validPiEntry(entry) {
  const string = value => typeof value === "string";
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const content = (value, types = ["text", "image"]) => string(value) || Array.isArray(value) && value.every(part => {
    if (!object(part) || !types.includes(part.type)) return false;
    switch (part.type) {
      case "text": return string(part.text);
      case "image": return string(part.data) && string(part.mimeType);
      case "thinking": return string(part.thinking);
      case "toolCall": return string(part.id) && string(part.name) && object(part.arguments);
      default: return false;
    }
  });
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !string(entry.id) || !entry.id
    || entry.parentId !== null && (!string(entry.parentId) || !entry.parentId)
    || !string(entry.timestamp) || !Number.isFinite(Date.parse(entry.timestamp))) return false;
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!message || typeof message !== "object" || !Number.isFinite(message.timestamp)) return false;
      switch (message.role) {
        case "user": return content(message.content);
        case "assistant": return Array.isArray(message.content) && content(message.content, ["text", "thinking", "toolCall"])
          && string(message.provider) && string(message.model) && string(message.api)
          && ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason)
          && object(message.usage) && object(message.usage.cost)
          && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => Number.isFinite(message.usage[key]))
          && ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => Number.isFinite(message.usage.cost[key]));
        case "toolResult": return Array.isArray(message.content) && content(message.content) && string(message.toolCallId) && string(message.toolName) && typeof message.isError === "boolean";
        case "custom": return string(message.customType) && content(message.content) && typeof message.display === "boolean";
        case "bashExecution": return string(message.command) && string(message.output) && typeof message.cancelled === "boolean" && typeof message.truncated === "boolean";
        case "branchSummary": return string(message.summary) && string(message.fromId);
        case "compactionSummary": return string(message.summary) && Number.isFinite(message.tokensBefore);
        default: return false;
      }
    }
    case "thinking_level_change": return string(entry.thinkingLevel);
    case "model_change": return string(entry.provider) && string(entry.modelId);
    case "compaction": return string(entry.summary) && string(entry.firstKeptEntryId) && Number.isFinite(entry.tokensBefore);
    case "branch_summary": return string(entry.summary) && string(entry.fromId);
    case "custom": return string(entry.customType);
    case "custom_message": return string(entry.customType) && content(entry.content) && typeof entry.display === "boolean";
    case "label": return string(entry.targetId) && (entry.label === undefined || string(entry.label));
    case "session_info": return entry.name === undefined || string(entry.name);
    default: return false;
  }
}

function routeParts(state, fallbackModel, fallbackEffort) {
  return {
    model: state?.model ?? state?.default_model ?? fallbackModel ?? null,
    effort: state?.thinking_level ?? fallbackEffort ?? null,
  };
}

function withPrompt(args, prompt) {
  if (prompt) args.push(prompt);
  return args;
}

export function buildHostLaunch(options, state, continuation = false) {
  assertHostOwnershipArgs(options);
  const pluginsRoot = options.pluginsRoot ?? resolve(EXECUTOR_ROOT, "..");
  const route = routeParts(state, options.fallbackModel, options.fallbackEffort);
  const prompt = continuation
    ? `Continue the active Statewright workflow from state '${state.state}'.`
    : options.prompt;
  const extra = options.hostArgs ?? [];

  switch (options.host) {
    case "pi": {
      if (!options.hostSessionFile) throw new Error("Pi execution requires an exact owned native session file");
      const args = [
        "--session", options.hostSessionFile,
        "--no-extensions",
        "--extension", resolve(pluginsRoot, "pi", "src", "index.ts"),
      ];
      if (route.model) args.push("--model", route.model);
      if (route.effort) args.push("--thinking", route.effort);
      return { command: options.hostBin ?? "pi", args: withPrompt([...args, ...extra], prompt) };
    }
    case "claude": {
      const args = [
        "--plugin-dir", resolve(pluginsRoot, "claude-code"),
      ];
      if (continuation || options.resumeWorkflow) args.push("--resume", options.hostSessionId);
      else args.push("--session-id", options.hostSessionId);
      if (route.model) args.push("--model", route.model.split("/").at(-1));
      return { command: options.hostBin ?? "claude", args: withPrompt([...args, ...extra], prompt) };
    }
    case "opencode": {
      // The default TUI command hands control to a background server and its
      // launcher exits. The executor owns the adapter bridge, so use the
      // foreground interactive runner and keep process lifetime authoritative.
      const args = ["run", "--interactive", "--dir", options.cwd];
      if (route.model) args.push("--model", route.model);
      if (route.effort) args.push("--variant", route.effort);
      return {
        command: options.hostBin ?? "opencode",
        args: withPrompt([...args, ...extra], prompt),
      };
    }
    case "cursor": {
      const args = [
        "--workspace", options.cwd,
        "--plugin-dir", resolve(pluginsRoot, "cursor"),
        "--trust",
      ];
      if (route.model) args.push("--model", route.model.split("/").at(-1));
      if (options.hostSessionId) args.push("--resume", options.hostSessionId);
      return {
        command: options.hostBin ?? "cursor-agent",
        args: withPrompt([...args, ...extra], prompt),
      };
    }
    case "omx": {
      const proxyPath = resolve(EXECUTOR_ROOT, "mcp-proxy.sh");
      const args = [
        "--direct",
        "-c", 'mcp_servers.statewright.command="bash"',
        "-c", `mcp_servers.statewright.args=[${JSON.stringify(proxyPath)}]`,
        "-c", 'mcp_servers.statewright.env_vars=["STATEWRIGHT_ADAPTER_URL","STATEWRIGHT_ADAPTER_TOKEN"]',
        ...extra,
      ];
      if (route.model) args.push("--model", route.model.split("/").at(-1));
      if (route.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(route.effort)}`);
      return {
        command: options.hostBin ?? "omx",
        args: withPrompt(args, prompt),
      };
    }
    default:
      throw new Error(`Unsupported Statewright executor host '${options.host}'.`);
  }
}

export function hostSupportsLiveRouting(host) {
  return hostRoutingMode(host) === "live";
}

export function hostRoutingMode(host) {
  if (host === "pi" || host === "opencode") return "live";
  if (host === "claude" || host === "cursor") return "restart";
  return "startup";
}

export function hostRequiresTerminalStop(host) {
  return host === "omx";
}

export const SUPPORTED_HOSTS = ["pi", "claude", "opencode", "cursor", "omx"];
