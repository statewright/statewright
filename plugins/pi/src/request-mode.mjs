import { InteractiveMode, runPrintMode, runRpcMode } from "@mariozechner/pi-coding-agent";

export function parsePiRequestMode(argv) {
  let mode = "interactive";
  let selected = false;
  let thinkingLevel;
  let terminated = false;
  const messages = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") throw new Error("Invalid managed Pi arguments");
    if (!terminated && arg === "--") { terminated = true; continue; }
    if (!terminated && (arg === "--mode" || arg === "--print" || arg === "-p")) {
      if (selected) throw new Error("Conflicting managed Pi modes");
      mode = arg === "--mode" ? argv[++i] : "text";
      selected = true;
      if (!["interactive", "text", "json", "rpc"].includes(mode)) throw new Error("Unsupported managed Pi mode");
    } else if (!terminated && arg === "--thinking") {
      if (thinkingLevel !== undefined) throw new Error("Conflicting managed Pi thinking levels");
      thinkingLevel = argv[++i];
      if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel)) throw new Error("Invalid managed Pi thinking level");
    } else if (!terminated && arg.startsWith("-")) throw new Error("Unsupported managed Pi option");
    else messages.push(arg);
  }
  if (mode === "rpc" && messages.length) throw new Error("RPC prompts must arrive through its native input protocol");
  return { mode, messages, thinkingLevel };
}

// Native modes bind extensions themselves. A pre-bind here would replay startup
// and violate once-only readiness. This owns only the supplied SDK frontend.
export async function runPiRequestMode(frontend, { mode, messages = [] }) {
  try {
    if (!["interactive", "text", "json", "rpc"].includes(mode)) throw new Error("Unsupported managed Pi mode");
    if (mode === "text" || mode === "json") return await runPrintMode(frontend.runtime, { mode, messages });
    if (mode === "rpc") { await runRpcMode(frontend.runtime); return 0; }
    await new InteractiveMode(frontend.runtime, { initialMessages: messages }).run();
    return 0;
  } finally { await frontend.close(); }
}
