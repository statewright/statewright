import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

function forward({ request, response, target, body }) {
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, {
      method: request.method,
      headers: forwardedHeaders(request.headers, target, body.length),
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", resolve);
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
      if (request.method === "POST" && new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/responses")) {
        const contentType = String(request.headers["content-type"] ?? "");
        if (contentType.includes("application/json") && body.length > 0) {
          const original = JSON.parse(body.toString("utf8"));
          const result = translateUnsupportedCompactionItems(original);
          translated = result.translated;
          if (translated > 0) body = Buffer.from(JSON.stringify(result.payload));
        }
      }
      if (translated > 0) await onTranslation({ translated });
      await forward({ request, response, target: upstreamUrl(upstreamBaseUrl, request.url), body });
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
