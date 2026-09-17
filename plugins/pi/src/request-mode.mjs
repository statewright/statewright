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
    if (mode === "text" || mode === "json") {
      // Stock text mode selects the last shared Agent message, including an
      // older response after a handled/command-only input. This read-only mode
      // view supplies only the latest privately owned, fully delivered response.
      const session = frontend.runtime.session;
      const view = new Proxy(session, { get(object, key) {
        if (key === "state") {
          const message = frontend.finalResponse;
          return { ...object.state, messages: message ? [message] : [] };
        }
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      } });
      const runtime = new Proxy(frontend.runtime, { get(object, key) {
        if (key === "session") return view;
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      } });
      return await runPrintMode(runtime, { mode, messages });
    }
    if (mode === "rpc") { await runRpcMode(frontend.runtime); return 0; }
    await new InteractiveMode(frontend.runtime, { initialMessages: messages }).run();
    return 0;
  } finally { await frontend.close(); }
}
