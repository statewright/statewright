import { InteractiveMode, runPrintMode, runRpcMode } from "@mariozechner/pi-coding-agent";
import { createPiRpcInput } from "./request-rpc-input.mjs";
import { installPiInteractiveConfiguration } from "./request-interactive.mjs";
export { installPiInteractiveConfiguration } from "./request-interactive.mjs";

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

// Only SDK modes receive this view. The real SDK session/extension contexts
// retain their existing methods and cannot turn project callbacks into input.
export function createPiRequestModeRuntime(frontend, { finalResponse = false } = {}) {
  const session = frontend.runtime.session;
  const abort = () => {
    const cancelled = frontend.cancelInput();
    // Interactive Agent.abort callers are void; RPC Session.abort awaits it.
    void cancelled.catch(() => {});
    return cancelled;
  };
  const agent = new Proxy(session.agent, { get(object, key) {
    if (key === "abort") return abort;
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  const view = new Proxy(session, { get(object, key) {
    if (key === "agent") return agent;
    if (key === "abort") return abort;
    if (key === "isStreaming") return object.isStreaming || frontend.inputPending;
    if (key === "state" && finalResponse) {
      const message = frontend.finalResponse;
      return { ...object.state, messages: message ? [message] : [] };
    }
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  return new Proxy(frontend.runtime, { get(object, key) {
    if (key === "session") return view;
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
}

// Native modes bind extensions themselves. A pre-bind here would replay startup
// and violate once-only readiness. This owns only the supplied SDK frontend.
export async function runPiRequestMode(frontend, { mode, messages = [] }) {
  try {
    if (!["interactive", "text", "json", "rpc"].includes(mode)) throw new Error("Unsupported managed Pi mode");
    const runtime = createPiRequestModeRuntime(frontend, { finalResponse: mode === "text" || mode === "json" });
    if (mode === "text" || mode === "json") {
      // Stock text mode selects the last shared Agent message, including an
      // older response after a handled/command-only input. This read-only mode
      // view supplies only the latest privately owned, fully delivered response.
      return await runPrintMode(runtime, { mode, messages });
    }
    if (mode === "rpc") {
      const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
      if (!descriptor?.configurable) throw new Error("Owning native RPC input unavailable");
      const inlet = createPiRpcInput({ input: process.stdin, configuration: frontend.configuration,
        output: process.stdout.write.bind(process.stdout), onDisconnect: frontend.close });
      Object.defineProperty(process, "stdin", { configurable: true, value: inlet.input });
      try { await runRpcMode(runtime); return 0; }
      finally { inlet.close(); Object.defineProperty(process, "stdin", descriptor); }
    }
    const interactive = new InteractiveMode(runtime, { initialMessages: messages });
    installPiInteractiveConfiguration(interactive, frontend.interactiveGesture);
    await interactive.run();
    return 0;
  } finally { await frontend.close(); }
}
