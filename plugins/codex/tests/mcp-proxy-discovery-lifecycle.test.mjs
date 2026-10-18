import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { getGatewayCredential } from "../scripts/lib/desktop-runtime/credential-store.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");
const key = `sw_live_${"a".repeat(64)}`;

async function writeCredentialHelper(directory) {
  const helper = join(directory, "credential-helper.mjs");
  await writeFile(helper, `#!/bin/sh
request=$(cat)
if [ "$STATEWRIGHT_TEST_CREDENTIAL_MODE" = unavailable ]; then
  printf '%s' '{"ok":false,"status":"unavailable","message":"fixture store unavailable"}'
  exit 1
fi
if [ "$STATEWRIGHT_TEST_CREDENTIAL_MODE" = failed_success ]; then
  printf '%s' '{"ok":true,"secret":"synthetic-failed-helper-value"}'
  exit 1
fi
case "$request" in
  *'"operation":"get"'*)
    if [ -f "$STATEWRIGHT_TEST_CREDENTIAL_PATH" ]; then
      secret=$(cat "$STATEWRIGHT_TEST_CREDENTIAL_PATH")
      printf '{"ok":true,"secret":"%s"}' "$secret"
    else
      printf '%s' '{"ok":false,"status":"missing"}'
      exit 0
    fi
    ;;
  *'"operation":"set"'*)
    secret=$(printf '%s' "$request" | sed -n 's/.*"secret":"\\([^"\\]*\\)".*/\\1/p')
    printf '%s' "$secret" > "$STATEWRIGHT_TEST_CREDENTIAL_PATH"
    printf '%s' '{"ok":true,"account":"fixture"}'
    ;;
  *)
    printf '%s' '{"ok":false,"status":"missing"}'
    exit 0
    ;;
esac
`);
  await chmod(helper, 0o700);
  return helper;
}

async function startFixture() {
  const protectedCalls = [];
  const server = createServer(async (request, response) => {
    const body = await new Promise(resolveBody => {
      let value = "";
      request.on("data", chunk => { value += chunk; });
      request.on("end", () => resolveBody(value));
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/oauth/device/code") {
      response.end(JSON.stringify({ device_code: "a".repeat(32), user_code: "ABCD-EFGH-IJKL", verification_uri_complete: "http://fixture/device?user_code=ABCD-EFGH-IJKL", expires_in: 60, interval: 5 }));
    } else if (request.url === "/api/oauth/device/token") {
      response.end(JSON.stringify({ token_type: "Bearer", access_token: key }));
    } else if (request.url === "/api/gateway/workflows") {
      protectedCalls.push(request.headers.authorization ?? "");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      response.end(JSON.stringify({ items: [] }));
    } else if (request.url?.startsWith("/mcp")) {
      const rpc = JSON.parse(body);
      protectedCalls.push(request.headers.authorization ?? "");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      response.end(JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ tool: rpc.params?.name, ok: true }) }] }, id: rpc.id }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "fixture route" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}`, protectedCalls };
}

async function writeGatewayProfile(home, origin) {
  const statewrightDir = join(home, ".statewright");
  await mkdir(statewrightDir, { recursive: true });
  await writeFile(join(statewrightDir, "environments.json"), JSON.stringify({
    gateways: {
      fixture: {
        gateway_url: `${origin}/mcp`,
        auth_url: origin,
      },
    },
  }));
}

function fixtureEnvironment({ home, root, helper, credentialPath, origin, mode = "missing" }) {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    SHELL: "/bin/false",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: join(home, "tmp"),
    CODEX_HOME: join(home, ".codex"),
    CODEX_CONFIG_PATH: join(home, ".codex", "config.toml"),
    STATEWRIGHT_NODE_BIN: process.execPath,
    STATEWRIGHT_CREDENTIAL_HELPER: helper,
    STATEWRIGHT_TEST_CREDENTIAL_PATH: credentialPath,
    STATEWRIGHT_TEST_CREDENTIAL_MODE: mode === "unavailable" ? "unavailable" : "",
    STATEWRIGHT_API_KEY: "",
    // Pin the selected fixture gateway directly. This avoids relying on any
    // user profile lookup while still exercising the proxy's profile resolver.
    STATEWRIGHT_GATEWAY_URL: `${origin}/mcp`,
    STATEWRIGHT_PB_URL: origin,
    STATEWRIGHT_ENV: "",
    STATEWRIGHT_NO_BROWSER: "true",
    STATEWRIGHT_NO_UPDATE_CHECK: "1",
    STATEWRIGHT_ADAPTER_URL: "",
    STATEWRIGHT_ADAPTER_TOKEN: "",
    STATEWRIGHT_MANAGED_MCP_URL: "",
    STATEWRIGHT_MANAGED_MCP_TOKEN: "",
    STATEWRIGHT_TELEMETRY_DIR: join(home, ".statewright", "fixture-telemetry"),
    STATEWRIGHT_ROUTE_CONTROL_DIR: join(home, ".statewright", "fixture-control"),
    STATEWRIGHT_DESKTOP_PLATFORM: "Fixture",
    STATEWRIGHT_DESKTOP_APP_EXECUTABLE: join(root, "fixture-no-desktop-app"),
    STATEWRIGHT_DESKTOP_BUNDLED_NODE: process.execPath,
  };
}

async function startProxy(root, environment) {
  const child = spawn("/bin/bash", [join(root, "mcp-proxy.sh")], { cwd: environment.HOME, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const rpc = JSON.parse(line);
      pending.get(rpc.id)?.resolve(rpc);
      pending.delete(rpc.id);
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  let next = 1;
  return {
    async call(method, params = {}) {
      const id = next++;
      const result = new Promise((resolveResponse, reject) => {
        pending.set(id, { resolve: resolveResponse, reject });
        setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}; proxy stderr: ${stderr || "<none>"}`));
        }, 12_000).unref();
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return result;
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.end();
      await Promise.race([
        once(child, "exit"),
        new Promise(resolveClose => setTimeout(resolveClose, 1_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    },
  };
}

test("Codex keeps workflow tools callable after device approval in one MCP session", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "statewright-codex-discovery-")));
  const home = join(directory, "home");
  const credentialPath = join(directory, "credential");
  const helper = await writeCredentialHelper(directory);
  const { server, origin, protectedCalls } = await startFixture();
  await writeGatewayProfile(home, origin);
  await mkdir(join(home, ".codex"), { recursive: true });
  const packageRoot = join(directory, "package");
  await cp(sourceRoot, packageRoot, {
    recursive: true,
    dereference: true,
    filter: path => !path.includes("node_modules"),
  });
  await mkdir(join(home, "tmp"), { recursive: true });
  const environment = fixtureEnvironment({ home, root: packageRoot, helper, credentialPath, origin });
  let client;
  try {
    client = await startProxy(packageRoot, environment);
    const initialized = await client.call("initialize", {});
    assert.equal(initialized.result.capabilities.tools.listChanged, false);
    const before = await client.call("tools/list", {});
    const beforeNames = before.result.tools.map(tool => tool.name);
    const packagedCatalog = JSON.parse(await readFile(join(packageRoot, "mcp-tool-catalog.json"), "utf8"));
    assert.deepEqual(before.result.tools, packagedCatalog);
    assert.equal(beforeNames.length, 15);
    assert.ok(beforeNames.includes("statewright_load_workflow"));
    assert.ok(beforeNames.includes("statewright_get_state"));
    const disconnected = await client.call("tools/call", { name: "statewright_load_workflow", arguments: { name: "canary" } });
    assert.ok(disconnected.error, JSON.stringify(disconnected));
    assert.equal(disconnected.error.code, -32001, JSON.stringify(disconnected));
    assert.equal(protectedCalls.length, 0);
    const connect = await client.call("tools/call", { name: "statewright_connect", arguments: {} });
    assert.match(connect.result.content[0].text, /ABCD-EFGH-IJKL/);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if ((await readFile(credentialPath, "utf8")).trim() === key) break;
      } catch { /* device poll still pending */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    assert.equal((await readFile(credentialPath, "utf8")).trim(), key);
    for (const name of ["statewright_load_workflow", "statewright_get_state"]) {
      const result = await client.call("tools/call", { name, arguments: name === "statewright_load_workflow" ? { name: "canary" } : {} });
      assert.equal(result.error, undefined);
      assert.match(result.result.content[0].text, new RegExp(name));
    }
    assert.ok(protectedCalls.length >= 3);
  } finally {
    await client?.close();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable OS credential storage is not reported as a missing credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-codex-store-"));
  const home = join(directory, "home");
  const helper = await writeCredentialHelper(directory);
  const { server, origin } = await startFixture();
  await writeGatewayProfile(home, origin);
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, "tmp"), { recursive: true });
  const environment = fixtureEnvironment({ home, root: sourceRoot, helper, credentialPath: join(directory, "credential"), origin, mode: "unavailable" });
  const client = await startProxy(sourceRoot, environment);
  try {
    const listed = await client.call("tools/list", {});
    assert.ok(listed.result.tools.some(tool => tool.name === "statewright_connect"));
    const result = await client.call("tools/call", { name: "statewright_get_state", arguments: {} });
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.error.code, -32003);
    assert.match(result.error.message, /credential store/i);
  } finally {
    await client.close();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential helper preserves a structured missing response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-codex-helper-"));
  const helper = await writeCredentialHelper(directory);
  try {
    await assert.rejects(
      getGatewayCredential("http://127.0.0.1:9999/mcp", {
        environment: { STATEWRIGHT_CREDENTIAL_HELPER: helper, STATEWRIGHT_TEST_CREDENTIAL_PATH: join(directory, "credential") },
        home: join(directory, "home"),
      }),
      error => error?.code === "CREDENTIAL_MISSING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential helper never accepts a success-shaped result from a failed process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-codex-helper-failure-"));
  const helper = await writeCredentialHelper(directory);
  try {
    await assert.rejects(
      getGatewayCredential("http://127.0.0.1:9999/mcp", {
        environment: {
          STATEWRIGHT_CREDENTIAL_HELPER: helper,
          STATEWRIGHT_TEST_CREDENTIAL_PATH: join(directory, "credential"),
          STATEWRIGHT_TEST_CREDENTIAL_MODE: "failed_success",
        },
        home: join(directory, "home"),
      }),
      error => error?.code === "CREDENTIAL_HELPER_FAILED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
