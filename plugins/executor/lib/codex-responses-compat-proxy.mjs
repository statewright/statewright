import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

export const ENCRYPTED_COMPACTION_HANDOFF = [
  "Provider handoff note: earlier assistant and tool history was compacted into an OpenAI-encrypted checkpoint that this provider cannot decode.",
  "Retained user and developer messages, plus all history after that checkpoint, remain in this request.",
  "Reconstruct prior state carefully from those inputs and the current workspace, and verify assumptions before acting.",
].join(" ");

function handoffMessage() {
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: ENCRYPTED_COMPACTION_HANDOFF }],
  };
}

export function translateUnsupportedCompactionItems(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) {
    return { payload, translated: 0 };
  }
  let translated = 0;
  const input = payload.input.map((item) => {
    if (item?.type !== "compaction" && item?.type !== "context_compaction") return item;
    translated += 1;
    return handoffMessage();
  });
  return translated === 0
    ? { payload, translated }
    : { payload: { ...payload, input }, translated };
}

function compatibleFunctionName(name) {
  const original = String(name);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(original)) return original;
  const stem = original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 47) || "tool";
  const digest = createHash("sha256").update(original).digest("hex").slice(0, 16);
  return `${stem}_${digest}`;
}

function mapItemFunctionNames(value, names) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => mapItemFunctionNames(entry, names));
  const mapped = { ...value };
  if (["function_call", "function_call_output"].includes(mapped.type) && names.has(mapped.name)) {
    mapped.name = names.get(mapped.name);
  }
  for (const [key, entry] of Object.entries(mapped)) {
    if (entry && typeof entry === "object") mapped[key] = mapItemFunctionNames(entry, names);
  }
  return mapped;
}

export function translateFunctionToolNames(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) {
    return { payload, renamed: 0, reverseNames: new Map() };
  }
  const names = new Map();
  const reverseNames = new Map();
  const tools = payload.tools.map((tool) => {
    if (tool?.type !== "function" || typeof tool.name !== "string") return tool;
    const wireName = compatibleFunctionName(tool.name);
    if (wireName === tool.name) return tool;
    names.set(tool.name, wireName);
    reverseNames.set(wireName, tool.name);
    return { ...tool, name: wireName };
  });
  if (names.size === 0) return { payload, renamed: 0, reverseNames };
  return {
    payload: {
      ...payload,
      tools,
      input: mapItemFunctionNames(payload.input, names),
      tool_choice: mapItemFunctionNames(payload.tool_choice, names),
    },
    renamed: names.size,
    reverseNames,
  };
}

function upstreamUrl(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl ?? "/", "http://127.0.0.1");
  const upstream = new URL(baseUrl);
  const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, "");
  upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}${suffix || "/"}`;
  upstream.search = incoming.search;
  return upstream;
}

function forwardedHeaders(headers, target, bodyLength) {
  const forwarded = { ...headers };
  delete forwarded.connection;
  delete forwarded["content-length"];
  delete forwarded.host;
  delete forwarded["proxy-connection"];
  delete forwarded["transfer-encoding"];
  forwarded.host = target.host;
  forwarded["content-length"] = String(bodyLength);
  return forwarded;
}

async function readRequestBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function restoreMappedNames(value, reverseNames) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => restoreMappedNames(entry, reverseNames));
  const restored = { ...value };
  if (typeof restored.name === "string" && reverseNames.has(restored.name)) {
    restored.name = reverseNames.get(restored.name);
  }
  for (const [key, entry] of Object.entries(restored)) {
    if (entry && typeof entry === "object") restored[key] = restoreMappedNames(entry, reverseNames);
  }
  return restored;
}

function restoreSseFunctionNames(reverseNames) {
  let pending = "";
  const rewriteLine = (line) => {
    const match = line.match(/^(\s*data:\s*)(.*?)(\r?)$/);
    if (!match || match[2] === "[DONE]") return line;
    try {
      return `${match[1]}${JSON.stringify(restoreMappedNames(JSON.parse(match[2]), reverseNames))}${match[3]}`;
    } catch {
      return line;
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      callback(null, lines.map(rewriteLine).join("\n") + (lines.length > 0 ? "\n" : ""));
    },
    flush(callback) {
      callback(null, pending ? rewriteLine(pending) : undefined);
    },
  });
}

function forward({ request, response, target, body, reverseNames }) {
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, {
      method: request.method,
      headers: forwardedHeaders(request.headers, target, body.length),
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      if (reverseNames.size > 0) delete responseHeaders["content-length"];
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        responseHeaders,
      );
      const eventStream = String(upstreamResponse.headers["content-type"] ?? "").includes("text/event-stream");
      const output = reverseNames.size > 0 && eventStream
        ? upstreamResponse.pipe(restoreSseFunctionNames(reverseNames))
        : upstreamResponse;
      output.pipe(response);
      output.once("end", resolve);
      upstreamResponse.once("error", reject);
    });
    upstream.once("error", reject);
    request.once("aborted", () => upstream.destroy());
    upstream.end(body);
  });
}

export async function startCodexResponsesCompatibilityProxy({
  upstreamBaseUrl,
  onTranslation = async () => {},
} = {}) {
  if (!upstreamBaseUrl) throw new Error("Statewright Responses compatibility proxy requires an upstream base URL.");
  const server = createServer(async (request, response) => {
    try {
      let body = await readRequestBody(request);
      let translated = 0;
      let renamedTools = 0;
      let reverseNames = new Map();
      if (request.method === "POST" && new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/responses")) {
        const contentType = String(request.headers["content-type"] ?? "");
        if (contentType.includes("application/json") && body.length > 0) {
          const original = JSON.parse(body.toString("utf8"));
          const compaction = translateUnsupportedCompactionItems(original);
          translated = compaction.translated;
          const tools = translateFunctionToolNames(compaction.payload);
          renamedTools = tools.renamed;
          reverseNames = tools.reverseNames;
          if (translated > 0 || renamedTools > 0) body = Buffer.from(JSON.stringify(tools.payload));
        }
      }
      if (translated > 0 || renamedTools > 0) await onTranslation({ translated, renamedTools });
      await forward({ request, response, target: upstreamUrl(upstreamBaseUrl, request.url), body, reverseNames });
    } catch (error) {
      if (!response.headersSent) {
        const status = error?.message === "request_too_large" ? 413 : 502;
        response.writeHead(status, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: "Statewright could not proxy the provider request." } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Statewright could not bind the Responses compatibility proxy.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  };
}
