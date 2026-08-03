import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = resolve(EXECUTOR_ROOT, "..");

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
  const route = routeParts(state, options.fallbackModel, options.fallbackEffort);
  const prompt = continuation
    ? `Continue the active Statewright workflow from state '${state.state}'.`
    : options.prompt;
  const extra = options.hostArgs ?? [];

  switch (options.host) {
    case "pi": {
      const args = [
        "--session-id", options.hostSessionId,
        "--extension", resolve(PLUGINS_ROOT, "pi", "src", "index.ts"),
      ];
      if (route.model) args.push("--model", route.model);
      if (route.effort) args.push("--thinking", route.effort);
      return { command: options.hostBin ?? "pi", args: withPrompt([...args, ...extra], prompt) };
    }
    case "claude": {
      const args = [
        "--plugin-dir", resolve(PLUGINS_ROOT, "claude-code"),
      ];
      if (continuation) args.push("--resume", options.hostSessionId);
      else args.push("--session-id", options.hostSessionId);
      if (route.model) args.push("--model", route.model.split("/").at(-1));
      if (route.effort) args.push("--effort", route.effort);
      return { command: options.hostBin ?? "claude", args: withPrompt([...args, ...extra], prompt) };
    }
    case "opencode": {
      const args = [options.cwd];
      if (route.model) args.push("--model", route.model);
      if (prompt) args.push("--prompt", prompt);
      return { command: options.hostBin ?? "opencode", args: [...args, ...extra] };
    }
    case "cursor": {
      const args = [
        "--workspace", options.cwd,
        "--plugin-dir", resolve(PLUGINS_ROOT, "cursor"),
        "--trust",
      ];
      if (route.model) args.push("--model", route.model.split("/").at(-1));
      if (continuation && options.hostSessionId) args.push("--resume", options.hostSessionId);
      return {
        command: options.hostBin ?? "cursor-agent",
        args: withPrompt([...args, ...extra], prompt),
      };
    }
    case "omx": {
      const args = [
        "--direct",
        "--plugin-dir", resolve(PLUGINS_ROOT, "omx"),
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
  if (host === "claude") return "restart";
  return "startup";
}

export const SUPPORTED_HOSTS = ["pi", "claude", "opencode", "cursor", "omx"];
