#!/usr/bin/env node
/**
 * Minimal local-only MCP server for Statewright repository references.
 *
 * Keep this beside reference-search.mjs when packaging it for a client. It
 * deliberately exposes no workflow or network operations: the active working
 * directory is the corpus and every answer is produced by the local index.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const searchScript = join(scriptDir, "reference-search.mjs");

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function toolDefinition() {
  return {
    name: "statewright_search_references",
    description: "Search the local repository index with deterministic lexical ranking. Returns read-only provenance, source hashes, rank reasons, and excerpts; ignored and secret material are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task, identifier, changed path, failed hypothesis, or validation signature to find" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      required: ["query"],
    },
  };
}

function search(query, limit) {
  return new Promise((resolve) => {
    execFile(process.execPath, [searchScript, "--root", process.cwd(), "--query", query, "--limit", String(limit ?? 8)], { timeout: 10_000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve("Reference search unavailable.");
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          resolve(String(result.error));
          return;
        }
        if (!result.results?.length) {
          resolve("No provenance-addressable references found.");
          return;
        }
        resolve(result.results.map((hit) => `## [${hit.source_kind}] ${hit.path}:${hit.line_start}-${hit.line_end}\ncommit: ${hit.commit_sha ?? "uncommitted"}\nhash: ${hit.source_hash}\nrank: ${hit.rank} [${hit.rank_reasons.join(", ")}]\n${hit.excerpt}`).join("\n\n"));
      } catch {
        resolve("Reference search unavailable.");
      }
    });
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "statewright-local-references", version: "0.1.0" } });
  } else if (message.method === "tools/list") {
    respond(message.id, { tools: [toolDefinition()] });
  } else if (message.method === "tools/call" && message.params?.name === "statewright_search_references") {
    const query = message.params.arguments?.query;
    if (!query) {
      respond(message.id, { content: [{ type: "text", text: "Missing required parameter: query" }], isError: true });
    } else {
      respond(message.id, { content: [{ type: "text", text: await search(String(query), message.params.arguments?.limit) }] });
    }
  } else if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
  }
}
