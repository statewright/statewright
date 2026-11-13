import {createHash} from "node:crypto";

// The Rust gateway sorts object keys before hashing. Numbers that serialize
// differently across the runtimes fail the digest comparison below.
function compareCodePoints(a, b) {
  const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    // Construct text directly: JSON.stringify reorders integer-like object
    // keys regardless of insertion order, unlike serde_json's sorted map.
    return `{${Object.keys(value).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error("MCP approval identity is not JSON");
}

export function digestJson(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function verifyOriginalInvocation(value, memory) {
  if (typeof value?.original_tool_name !== "string" || !value.original_tool_name.startsWith("mcp__")
      || !value.original_tool_input || typeof value.original_tool_input !== "object"
      || Array.isArray(value.original_tool_input) || !memory?.grant_policy_v2_sha256) return null;
  return digestJson([value.original_tool_name, value.original_tool_input]) === memory.invocation_sha256
    ? value.original_tool_name : null;
}

export function bindCatalogue(toolName, pages, generation, dependency) {
  if (!Array.isArray(pages) || typeof generation !== "string" || !generation || !/^[a-f0-9]{64}$/.test(dependency)) return null;
  const matches = [];
  for (const server of pages) {
    if (typeof server?.name !== "string" || !server.tools || typeof server.tools !== "object" || Array.isArray(server.tools)) return null;
    for (const [name, descriptor] of Object.entries(server.tools)) {
      if (toolName === `mcp__${server.name}__${name}` || toolName === name) {
        matches.push({server:server.name, name, descriptor, authStatus:server.authStatus ?? null});
      }
    }
  }
  if (matches.length !== 1) return null;
  // A generation scope is deliberately conservative: reconnect requires a
  // fresh review until a durable host identity has been verified.
  return digestJson({contract:1, dependency, generation, match:matches[0]});
}

// Only actual in-flight host items can establish the origin of a request.
// Store hashes and identities, never the arguments supplied by the host.
export class NativeMcpItems {
  constructor({maxItems = 256, maxTurns = 4096} = {}) {
    this.maxItems = maxItems;
    this.maxTurns = maxTurns;
    this.turns = new Map();
    this.seenTurns = new Set();
    this.items = new Map();
    this.seen = new Set();
  }
  clear() { this.turns.clear(); this.seenTurns.clear(); this.items.clear(); this.seen.clear(); }
  observe(message) {
    const p = message?.params ?? {}, thread = p.threadId;
    if (typeof thread !== "string") return;
    if (message.method === "turn/started" && typeof p.turn?.id === "string") {
      const key = JSON.stringify([thread, p.turn.id]);
      if (this.seenTurns.has(key)) return;
      this.retire(thread); this.turns.delete(thread);
      if (this.seenTurns.size >= this.maxTurns) return;
      this.seenTurns.add(key); this.turns.set(thread, p.turn.id); return;
    }
    if (message.method === "turn/completed" && this.turns.get(thread) === p.turn?.id) {
      this.retire(thread); this.turns.delete(thread); return;
    }
    if (message.method === "item/completed") {
      this.items.delete(JSON.stringify([thread, p.turnId, p.item?.id])); return;
    }
    const item = p.item;
    if (message.method !== "item/started" || this.turns.get(thread) !== p.turnId
        || String(item?.type ?? "").toLowerCase() !== "mcptoolcall"
        || typeof item.id !== "string" || typeof item.server !== "string"
        || typeof item.tool !== "string" || !item.arguments || typeof item.arguments !== "object"
        || Array.isArray(item.arguments)
        || item.appContext?.connectorId != null && typeof item.appContext.connectorId !== "string"
        || item.appContext?.linkId != null && typeof item.appContext.linkId !== "string") return;
    const key = JSON.stringify([thread, p.turnId, item.id]);
    // Duplicate IDs are ambiguous even if they happen to have identical data.
    if (this.seen.has(key)) { this.items.set(key, null); return; }
    if (this.seen.size >= this.maxItems) return;
    this.seen.add(key);
    if (item.tool.startsWith("mcp__") && !item.tool.startsWith(`mcp__${item.server}__`)) {
      this.items.set(key, null); return;
    }
    const name = item.tool.startsWith("mcp__") ? item.tool : `mcp__${item.server}__${item.tool}`;
    try {
      this.items.set(key, {name, server:item.server, invocation:digestJson([name, item.arguments]),
        connectorId:item.appContext?.connectorId ?? null, linkId:item.appContext?.linkId ?? null});
    } catch { this.items.set(key, null); }
  }
  retire(thread) {
    for (const key of this.items.keys()) if (JSON.parse(key)[0] === thread) this.items.delete(key);
    for (const key of this.seen) if (JSON.parse(key)[0] === thread) this.seen.delete(key);
  }
  match({threadId, turnId, toolUseId, toolName, invocation}) {
    if (typeof turnId !== "string" || typeof toolUseId !== "string" || this.turns.get(threadId) !== turnId) return null;
    const item = this.items.get(JSON.stringify([threadId, turnId, toolUseId]));
    if (!item || item.name !== toolName || item.invocation !== invocation) return null;
    return {server:item.server, connectorId:item.connectorId, linkId:item.linkId};
  }
}
