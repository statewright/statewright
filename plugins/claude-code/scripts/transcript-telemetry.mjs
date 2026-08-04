#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EMPTY_USAGE = Object.freeze({
  input_tokens: 0,
  cache_write_input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
});

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedUsage(usage = {}) {
  const input = number(usage.input_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  const cached = number(usage.cache_read_input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: input,
    cache_write_input_tokens: cacheWrite,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + cacheWrite + cached + output,
  };
}

function addUsage(total, delta) {
  const result = {};
  for (const key of Object.keys(EMPTY_USAGE)) result[key] = number(total?.[key]) + number(delta?.[key]);
  return result;
}

export function assistantUsageRecord(record) {
  const message = record?.message;
  if (message?.role !== "assistant" || !message.usage || !message.id) return null;
  return {
    id: String(message.id),
    model: typeof message.model === "string" ? message.model : "",
    timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
    usage: normalizedUsage(message.usage),
  };
}

export function parseAssistantUsageJsonl(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = assistantUsageRecord(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A malformed transcript line is not provider usage and is never projected.
    }
  }
  return entries;
}

async function findTranscript(home, sessionId) {
  const root = join(home, ".claude", "projects");
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

async function readNewJsonl(path, cursor) {
  const metadata = await stat(path);
  const offset = cursor.path === path && cursor.offset <= metadata.size ? cursor.offset : 0;
  if (offset === metadata.size) return { text: "", offset, path };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(metadata.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline < 0) return { text: "", offset, path };
    return {
      text: buffer.subarray(0, lastNewline + 1).toString("utf8"),
      offset: offset + lastNewline + 1,
      path,
    };
  } finally {
    await handle.close();
  }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function eventId(runId, epoch, sequence, usage) {
  return createHash("sha256")
    .update(`${runId}:${epoch}:${sequence}:${JSON.stringify(usage)}`)
    .digest("hex");
}

export async function projectClaudeTranscriptUsage(options) {
  const state = await readJson(options.stateFile, null);
  const epoch = Number.parseInt(await readFile(options.epochFile, "utf8").catch(() => "0"), 10);
  if (!state?.run_id || !state?.state || !Number.isInteger(epoch) || epoch < 1 || !options.sessionId) {
    return { projected: false, reason: "no_active_state" };
  }
  const transcript = await findTranscript(options.home, options.sessionId);
  if (!transcript) return { projected: false, reason: "transcript_unavailable" };

  const ledger = await readJson(options.ledgerFile, { cursor: {}, seen: {}, epochs: {}, sequence: 0 });
  const update = await readNewJsonl(transcript, ledger.cursor ?? {});
  ledger.cursor = { path: update.path, offset: update.offset };
  ledger.seen ??= {};
  const newEntries = [];
  for (const entry of parseAssistantUsageJsonl(update.text)) {
    if (ledger.seen[entry.id]) continue;
    ledger.seen[entry.id] = true;
    newEntries.push(entry);
  }
  if (newEntries.length === 0) {
    await writeJson(options.ledgerFile, ledger);
    return { projected: false, reason: "no_new_usage" };
  }

  const epochKey = String(epoch);
  const prior = ledger.epochs?.[epochKey] ?? { usage: { ...EMPTY_USAGE }, model: "", timestamp: "" };
  const delta = newEntries.reduce((total, entry) => addUsage(total, entry.usage), { ...EMPTY_USAGE });
  const latest = newEntries.at(-1);
  const cumulative = addUsage(prior.usage, delta);
  ledger.epochs[epochKey] = { usage: cumulative, model: latest.model, timestamp: latest.timestamp };
  ledger.sequence = number(ledger.sequence) + 1;
  await writeJson(options.ledgerFile, ledger);

  const budget = {
    run_id: state.run_id,
    state: state.state,
    state_epoch: epoch,
    provider: "anthropic",
    model: latest.model,
    effort: "",
    precision: "exact",
    token_usage: cumulative,
    token_attribution: { reported_reasoning_output_tokens: 0 },
    context_budget_bytes: number(state.context_budget_bytes),
  };
  const event = {
    event_id: eventId(state.run_id, epoch, ledger.sequence, cumulative),
    run_id: state.run_id,
    thread_id: options.threadId,
    workflow: state.workflow ?? "",
    event: "provider_token_usage",
    state: state.state,
    provider: "anthropic",
    source: "claude_transcript",
    precision: "exact",
    timestamp: latest.timestamp,
    sequence: ledger.sequence,
    model: latest.model,
    token_usage_delta: delta,
    state_budget: budget,
  };
  const response = await fetch(`${options.pbUrl.replace(/\/$/, "")}/api/gateway/telemetry/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ events: [event] }),
  });
  if (!response.ok) throw new Error(`telemetry endpoint returned HTTP ${response.status}`);
  return { projected: true, event };
}

function parseArgs(argv) {
  const options = { home: process.env.HOME, pbUrl: process.env.STATEWRIGHT_PB_URL, apiKey: process.env.STATEWRIGHT_TELEMETRY_API_KEY };
  const flags = new Map([
    ["--session-id", "sessionId"], ["--thread-id", "threadId"], ["--state-file", "stateFile"],
    ["--epoch-file", "epochFile"], ["--ledger-file", "ledgerFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[key] = argv[++index];
  }
  for (const key of ["sessionId", "threadId", "stateFile", "epochFile", "ledgerFile", "home", "pbUrl", "apiKey"]) {
    if (!options[key]) throw new Error(`${key} is required`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  projectClaudeTranscriptUsage(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ projected: result.projected === true, reason: result.reason ?? "" })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`[statewright] Claude transcript telemetry: ${error.message}\n`);
      process.exitCode = 1;
    });
}
