import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { literalInvocation, literalCommandList } from "./command-evidence.mjs";

const MAX_REFERENCE_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 12 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const safeName = value => /^[A-Za-z0-9][A-Za-z0-9+_.-]{0,63}$/.test(value);

/** Inspect documentation as bytes. Never launch a command, plugin, shell,
 * man formatter or --help handler during classifier evidence discovery. */
async function document(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) return null;
    const bytes = await readFile(path);
    const decoded = path.endsWith(".gz")
      ? gunzipSync(bytes, { maxOutputLength: MAX_REFERENCE_BYTES }) : bytes;
    if (decoded.length > MAX_REFERENCE_BYTES || decoded.includes(0)) return null;
    return { text: decoded.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return null; }
}

export function relevantHelp(text, args) {
  const lines = text.split(/\r?\n/);
  // Literal strings only: '-v' is neither a grep option nor a regex here.
  const flags = [...new Set(args.filter(value => /^--?[A-Za-z]/.test(value))
    .map(value => value.split("=", 1)[0]))].slice(0, 32);
  const positions = args.filter(value => safeName(value) && !value.startsWith("-"));
  const selectors = [...flags, ...positions].slice(0, 48);
  const selected = new Set(Array.from({length: Math.min(20, lines.length)}, (_, index) => index));
  const matched = new Set();
  for (let index = 0; index < lines.length; index++) {
    for (const selector of selectors) {
      if (lines[index].includes(selector)) {
        matched.add(selector);
        for (let at = Math.max(0, index - 2); at <= Math.min(lines.length - 1, index + 3); at++) selected.add(at);
      }
    }
  }
  let excerpt = "", truncated = false;
  const locations = [];
  for (const index of [...selected].sort((a,b) => a-b)) {
    const next = `${index + 1}: ${lines[index]}\n`;
    if (Buffer.byteLength(excerpt + next) > MAX_EXCERPT_BYTES) { truncated = true; break; }
    excerpt += next;
    locations.push(index + 1);
  }
  return { excerpt, line_numbers: locations, flags,
    unmatched_flags: flags.filter(flag => !matched.has(flag)),
    completeness: truncated ? "budget_exhausted" : selected.size < lines.length ? "excerpt" : "full" };
}

export async function collectCommandReferences(toolName, input, options = {}) {
  if (!["exec_command", "bash", "shell", "terminal", "run_command"].includes(String(toolName).toLowerCase())) return null;
  const command = input?.command ?? input?.cmd;
  if (typeof command !== "string" || command.length > 8192) return null;
  const units = literalCommandList(command) ?? [command];
  if (units.length > 32) return null;
  const roots = options.roots ?? [
    ...String(process.env.STATEWRIGHT_COMMAND_REFERENCE_ROOTS ?? "").split(delimiter).filter(Boolean),
    "/usr/share/man", "/usr/local/share/man", "/opt/homebrew/share/man",
  ];
  const entries = [];
  for (const [index, unit] of units.entries()) {
    const invocation = literalInvocation(unit);
    if (!invocation) {
      entries.push({ index, status: "unsupported_invocation", executable: null });
      continue;
    }
    const executable = basename(invocation.executable);
    if (!safeName(executable)) {
      entries.push({index, executable: null, status: "missing"});
      continue;
    }
    const references = [];
    const selectors = invocation.args.filter(value => safeName(value) && !value.startsWith("-")).slice(0, 8);
    const names = [...new Set([
      ...selectors.map(value => `${executable}-${value}`),
      ...(selectors.length > 1 ? [`${executable}-${selectors.slice(0, 3).join("-")}`] : []),
      executable,
    ])];
    // Search every standard man section, compressed or plain, and static help
    // caches. Discovery is bounded to configured documentation roots.
    for (const root of roots.slice(0, 8)) {
      const candidates = [];
      for (const name of names) {
        candidates.push(`${name}.help.txt`, `${name}.txt`);
        for (let section = 1; section <= 9; section++) {
          candidates.push(`man${section}/${name}.${section}`, `man${section}/${name}.${section}.gz`);
        }
      }
      for (const candidate of candidates) {
        const found = await document(join(root, candidate));
        if (!found) continue;
        references.push({source: candidate, sha256: found.sha256,
          version_match: "unverified", ...relevantHelp(found.text, invocation.args)});
        if (references.length === 3) break;
      }
      if (references.length === 3) break;
    }
    entries.push({index, executable, status: references.length ? "available" : "missing", references});
  }
  const envelope = {schema: "statewright/command-reference/v1", tool_name: toolName,
    command, collected_at_ms: (options.now ?? Date.now)(), entries};
  return Buffer.byteLength(JSON.stringify(envelope)) <= MAX_ENVELOPE_BYTES ? envelope : null;
}
