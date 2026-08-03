#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppServerClient } from "../../../plugins/codex/scripts/lib/app-server-client.mjs";
import { buildAppServerArgs } from "../../../plugins/codex/scripts/statewright-codex.mjs";

const [name, definitionPath, cwd = process.cwd()] = process.argv.slice(2);
if (!name || !definitionPath) {
  throw new Error("usage: register-workflow.mjs NAME DEFINITION [CWD]");
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const transportSessionId = `br_codex_tui_register_${randomUUID().replaceAll("-", "")}`;
const client = new AppServerClient({
  args: buildAppServerArgs(transportSessionId),
  cwd: resolve(cwd),
  env: { ...process.env, STATEWRIGHT_MCP_SESSION_ID: transportSessionId },
});

try {
  await client.start();
  await client.request("initialize", {
    clientInfo: { name: "statewright-tui-tests", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");

  const catalog = await client.request("model/list", {
    cursor: null,
    includeHidden: true,
    limit: 100,
  });
  const selected = catalog.data?.find((model) => model.isDefault) ?? catalog.data?.[0];
  if (!selected) throw new Error("Codex app-server returned no models");
  const started = await client.request("thread/start", {
    cwd: resolve(cwd),
    model: selected.model ?? selected.id,
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
  });

  let serverName = null;
  let statewrightServers = [];
  for (let attempt = 0; attempt < 10 && !serverName; attempt += 1) {
    const status = await client.request("mcpServerStatus/list", {
      threadId: started.thread.id,
      cursor: null,
      limit: 100,
      detail: "full",
    });
    const candidates = status.data?.filter((server) =>
      Object.keys(server.tools ?? {}).some((tool) =>
        tool.endsWith("statewright_create_workflow"),
      )) ?? [];
    statewrightServers = candidates.map((server) => server.name).sort();
    serverName = candidates.find((server) => server.name === "statewright_adapter")?.name;
    if (!serverName) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (!serverName) {
    throw new Error("launcher-owned Statewright MCP server did not expose workflow creation");
  }

  const definition = JSON.parse(await readFile(resolve(definitionPath), "utf8"));
  const result = await client.request("mcpServer/tool/call", {
    threadId: started.thread.id,
    server: serverName,
    tool: "statewright_create_workflow",
    arguments: { name, definition, overwrite: true },
  });
  if (result?.isError === true) {
    throw new Error(`workflow registration failed: ${JSON.stringify(result)}`);
  }
  const load = await client.request("mcpServer/tool/call", {
    threadId: started.thread.id,
    server: serverName,
    tool: "statewright_load_workflow",
    arguments: { name, session_id: started.thread.id },
  });
  if (load?.isError === true) {
    throw new Error(`workflow round-trip load failed: ${JSON.stringify(load)}`);
  }
  const stateResult = await client.request("mcpServer/tool/call", {
    threadId: started.thread.id,
    server: serverName,
    tool: "statewright_get_state",
    arguments: {},
  });
  const stateText = stateResult?.content?.find((item) => item.type === "text")?.text;
  const state = JSON.parse(stateText ?? "null");
  const creationText = result?.content?.find((item) => item.type === "text")?.text;
  const loadText = load?.content?.find((item) => item.type === "text")?.text;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    name,
    statewright_servers: statewrightServers,
    creation: parseMaybeJson(creationText),
    load: parseMaybeJson(loadText),
    state: state?.state ?? null,
    instructions: state?.instructions ?? null,
    meta: state?.meta ?? null,
  })}\n`);
} finally {
  await client.close();
}
