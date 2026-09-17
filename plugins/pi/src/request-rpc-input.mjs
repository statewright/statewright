import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const fields = Object.freeze({ set_model: ["provider", "modelId"], cycle_model: [],
  set_thinking_level: ["level"], cycle_thinking_level: [], set_session_name: ["name"] });
const has = key => typeof key === "string" && Object.hasOwn(fields, key);

export function snapshotPiRpcConfiguration(command) {
  let input;
  try { input = structuredClone(command); } catch { throw new Error("Invalid native RPC configuration"); }
  if (!input || typeof input !== "object" || Array.isArray(input) || !has(input.type)) {
    throw new Error("Invalid native RPC configuration");
  }
  const required = ["type", ...fields[input.type]];
  if (Object.keys(input).some(key => ![...required, "id"].includes(key)) || required.some(key => !Object.hasOwn(input, key))
    || Object.hasOwn(input, "id") && (typeof input.id !== "string" || input.id.length > 256)
    || fields[input.type].some(key => typeof input[key] !== "string" || !input[key].trim() || input[key].length > (key === "name" ? 4096 : 256))
    || input.type === "set_thinking_level" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(input.level)) {
    throw new Error("Invalid native RPC configuration");
  }
  return Object.freeze(input);
}

// SDK0.73.0 takes its input from process.stdin and has no input/command-handler
// injection. Route these synchronous native mutations before the SDK handler,
// leaving every other protocol record to its original dispatcher. No project
// callback receives this inlet or its configuration capability.
export function createPiRpcInput({ input, configuration, output, onDisconnect }) {
  if (typeof input?.on !== "function" || typeof input?.pause !== "function" || typeof input?.resume !== "function"
    || typeof configuration !== "function" || typeof output !== "function" || typeof onDisconnect !== "function") {
    throw new Error("Owning native RPC input unavailable");
  }
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let started = false;
  let active = true;
  const detach = () => { input.off("data", data); input.off("end", end); input.off("error", disconnect); input.off("close", disconnect); };
  const stop = () => { if (!active) return; active = false; detach(); input.pause(); filtered.push(null); };
  const disconnect = () => {
    if (!active) return;
    stop();
    // Invalidate synchronously; SDK EOF disposal awaits the same owned close.
    try { Promise.resolve(onDisconnect()).catch(() => {}); } catch { /* no response or resumed effect on disconnect */ }
  };
  const respond = response => {
    if (!active) return;
    try { output(`${JSON.stringify(response)}\n`); } catch { disconnect(); }
  };
  const line = record => {
    let command;
    try { command = JSON.parse(record); } catch { /* original SDK parse diagnostics */ }
    if (!command || typeof command !== "object" || Array.isArray(command) || !has(command.type)) {
      if (!filtered.push(`${record}\n`)) input.pause();
      return;
    }
    const reply = { id: command.id, type: "response", command: command.type };
    let pending;
    try {
      // Invoke immediately: no registry lookup or microtask precedes capture.
      pending = configuration(snapshotPiRpcConfiguration(command));
    } catch (error) { respond({ ...reply, success: false, error: error.message }); return; }
    Promise.resolve(pending).then(value => respond({ ...reply, success: true, ...(value === undefined ? {} : { data: value }) }),
      error => respond({ ...reply, success: false, error: error instanceof Error ? error.message : String(error) }));
  };
  const data = chunk => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let index;
    while (active && (index = buffer.indexOf("\n")) !== -1) {
      const record = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      line(record);
    }
  };
  const end = () => { buffer += decoder.end(); if (active && buffer) line(buffer); buffer = ""; disconnect(); };
  const filtered = new Readable({ read() {
    if (!active) return;
    if (!started) {
      started = true;
      input.on("data", data); input.on("end", end);
      if (input.readableEnded || input.destroyed) { disconnect(); return; }
    }
    input.resume();
  } });
  // The SDK awaits native bind before attaching its reader. Terminal input
  // must invalidate that startup too, without consuming any command bytes.
  input.on("error", disconnect); input.on("close", disconnect);
  input.pause();
  return Object.freeze({ input: filtered, close: stop });
}
