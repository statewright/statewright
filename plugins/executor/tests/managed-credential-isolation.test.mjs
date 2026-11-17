import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexShellEnvironmentPolicyArgs, configuredShellExcludes, ensurePrivateDirectory, GENERIC_SHELL_CREDENTIAL_EXCLUDES,
  isStatewrightCredentialEnvName, managedAgentEnvironment, managedCodexEnvironment,
  readCredentialHandoff, removeManagedMcpTokenFile, stripStatewrightCredentials, writeManagedMcpTokenFile } from "../lib/managed-credential-isolation.mjs";
import { runManagedClient } from "../lib/managed-client-supervisor.mjs";
import { ensureCodexAppServerResident } from "../lib/codex-app-server-resident.mjs";

// Obviously fake credentials, deliberately not shaped like sw_ keys so the
// secret scanner needs no allowlist. Nothing here may reach a real key.
const FAKE_KEY = "FAKE-isolation-api-key";
const FAKE_REFRESH = "FAKE-isolation-refresh";
const FAKE_TELEMETRY_KEY = "FAKE-isolation-telemetry";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_PROXY = resolve(TEST_DIR, "../../codex/mcp-proxy.sh");
const MCP_CONFIG = resolve(TEST_DIR, "../../codex/.mcp.json");
const CLAUDE_MCP_PROXY = resolve(TEST_DIR, "../../claude-code/mcp-proxy.sh");

test("credential names are stripped while non-secret Statewright settings survive", () => {
  const stripped = stripStatewrightCredentials({
    PATH: "/usr/bin",
    GITHUB_TOKEN: "user-owned",
    STATEWRIGHT_API_KEY: FAKE_KEY,
    STATEWRIGHT_TELEMETRY_API_KEY: FAKE_TELEMETRY_KEY,
    STATEWRIGHT_REFRESH_TOKEN: FAKE_REFRESH,
    STATEWRIGHT_MANAGED_MCP_TOKEN: "fake-bridge",
    STATEWRIGHT_MANAGED_MCP_TOKEN_FILE: "/tmp/fake",
    STATEWRIGHT_ADAPTER_TOKEN: "fake-adapter",
    STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN: "fake-pool",
    STATEWRIGHT_FUTURE_SECRET: "fake-secret",
    STATEWRIGHT_GATEWAY_URL: "https://gateway.invalid",
    STATEWRIGHT_CREDENTIAL_HELPER: "/usr/local/bin/helper",
    STATEWRIGHT_NATIVE_TOKEN_TELEMETRY: "false",
    STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:1",
  });
  assert.deepEqual(Object.keys(stripped).sort(), [
    "GITHUB_TOKEN", "PATH", "STATEWRIGHT_CREDENTIAL_HELPER", "STATEWRIGHT_GATEWAY_URL",
    "STATEWRIGHT_MANAGED_MCP_URL", "STATEWRIGHT_NATIVE_TOKEN_TELEMETRY",
  ]);
  assert.equal(isStatewrightCredentialEnvName("STATEWRIGHT_OAUTH_REFRESH_TOKEN_V2"), true);
  const managed = managedCodexEnvironment({ STATEWRIGHT_API_KEY: FAKE_KEY, PATH: "/bin" },
    { mcpUrl: "http://127.0.0.1:2", tokenFile: "/tmp/token", extra: { STATEWRIGHT_MANAGED_MCP_TOKEN: "fake" } });
  assert.deepEqual(managed, { PATH: "/bin", STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:2", STATEWRIGHT_MANAGED_MCP_TOKEN_FILE: "/tmp/token" });
});

test("the Codex shell policy override unions a user's own exclude list", async () => {
  assert.deepEqual(configuredShellExcludes('model = "x"\n[shell_environment_policy]\ninherit = "core"\nexclude = [\n  "AWS_*", # cloud\n  \'AZURE_*\',\n]\n[other]\nexclude = ["NOPE"]\n'),
    ["AWS_*", "AZURE_*"]);
  assert.deepEqual(configuredShellExcludes('shell_environment_policy.exclude = ["GCP_*"]\n'), ["GCP_*"]);
  assert.deepEqual(configuredShellExcludes("[other]\nexclude = [\"NOPE\"]\n"), []);
  const home = await mkdtemp(join(tmpdir(), "statewright-shell-policy-"));
  try {
    await writeFile(join(home, "config.toml"), '[shell_environment_policy]\nexclude = ["AWS_*"]\n');
    const [flag, value] = await codexShellEnvironmentPolicyArgs({ codexHome: home });
    assert.equal(flag, "-c");
    const list = JSON.parse(value.replace(/^shell_environment_policy\.exclude=/, ""));
    assert.equal(list[0], "AWS_*");
    for (const pattern of ["STATEWRIGHT_*API_KEY*", "STATEWRIGHT_*_TOKEN", "STATEWRIGHT_*_TOKEN_FILE", "STATEWRIGHT_*REFRESH*"]) {
      assert.ok(list.includes(pattern), pattern);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the bridge token file is owner-only and only its owner removes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-token-file-"));
  try {
    const path = await writeManagedMcpTokenFile(directory, "fake-bridge-token-one");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(await readFile(path, "utf8") === "fake-bridge-token-one");
    await writeManagedMcpTokenFile(directory, "fake-bridge-token-two");
    await removeManagedMcpTokenFile(path, "fake-bridge-token-one");
    assert.ok(await readFile(path, "utf8") === "fake-bridge-token-two", "a stale owner must not delete a successor's token");
    await removeManagedMcpTokenFile(path, "fake-bridge-token-two");
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(writeManagedMcpTokenFile(directory, ""), /unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the resident credential handoff reads one JSON document from its pipe", async () => {
  assert.equal(await readCredentialHandoff(Readable.from([JSON.stringify({ apiKey: ` ${FAKE_KEY} ` })])), FAKE_KEY);
  assert.equal(await readCredentialHandoff(Readable.from([""])), null);
  assert.equal(await readCredentialHandoff(Readable.from(["not json"])), null);
  assert.equal(await readCredentialHandoff({ isTTY: true }), null);
});

// A stand-in Statewright gateway: it only answers callers presenting the
// (fake) user key, which proves the managed connection still authenticates.
async function fakeGateway() {
  const seen = { authorized: 0, rejected: 0 };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    if (request.headers.authorization !== `Bearer ${FAKE_KEY}`) {
      seen.rejected += 1;
      response.writeHead(401).end();
      return;
    }
    seen.authorized += 1;
    const rpc = JSON.parse(raw);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null,
      result: { content: [{ type: "text", text: "gateway-authenticated" }] } }));
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  return { seen, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }) };
}

// A stand-in Codex. Like real Codex it (1) runs agent commands with its own
// environment, and (2) launches the Statewright MCP proxy with only the
// variables its plugin .mcp.json allowlists. It records names and booleans
// only, never credential values.
async function writeFakeCodex(home, resultsPath) {
  const fake = join(home, "fake-codex.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const FAKE_SECRETS = ${JSON.stringify([FAKE_KEY, FAKE_REFRESH, FAKE_TELEMETRY_KEY])};
const args = process.argv.slice(2);
const tokenFile = process.env.STATEWRIGHT_MANAGED_MCP_TOKEN_FILE ?? null;
let bridgeToken = null;
try { bridgeToken = tokenFile ? readFileSync(tokenFile, "utf8") : null; } catch {}
// Credential carriers, not the token-file path or token telemetry flags.
const credentialLike = name => /^STATEWRIGHT_\\w*(API_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(name) || /^STATEWRIGHT_\\w*REFRESH/i.test(name);
function inspect(env) {
  const values = Object.values(env).map(String);
  return {
    credentialNames: Object.keys(env).filter(credentialLike).sort(),
    fakeSecretInValues: values.some(value => FAKE_SECRETS.some(secret => value.includes(secret))),
    bridgeTokenInValues: Boolean(bridgeToken) && values.some(value => value.includes(bridgeToken)),
  };
}
// An agent command (for example a test) that inherits Codex's whole env.
const command = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: process.env, encoding: "utf8" });
const commandEnv = JSON.parse(command.stdout || "{}");
const mcpConfig = JSON.parse(readFileSync(${JSON.stringify(MCP_CONFIG)}, "utf8")).mcpServers.statewright;
const mcpEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp" };
for (const name of mcpConfig.env_vars) if (process.env[name] !== undefined) mcpEnv[name] = process.env[name];
async function mcpRoundTrip() {
  const proxy = spawn("/bin/bash", [${JSON.stringify(MCP_PROXY)}], { env: mcpEnv, cwd: process.env.HOME });
  let out = "";
  proxy.stdout.on("data", chunk => { out += chunk; });
  proxy.stderr.resume();
  const closed = new Promise(resolveClose => proxy.once("close", resolveClose));
  proxy.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
  ].map(value => JSON.stringify(value)).join("\\n") + "\\n");
  await closed;
  const reply = out.trim().split("\\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(value => value?.id === 2);
  return reply?.result?.content?.[0]?.text ?? null;
}
async function report() {
  // A TUI attached to a resident (--remote) reports separately from it.
  writeFileSync(args.includes("--remote") ? ${JSON.stringify(resultsPath + ".tui")} : ${JSON.stringify(resultsPath)}, JSON.stringify({
    args,
    tokenFileProvided: Boolean(tokenFile),
    codex: inspect(process.env),
    command: inspect(commandEnv),
    mcpReply: await mcpRoundTrip(),
  }));
}
if (args.includes("app-server")) {
  const { WebSocketServer } = await import(${JSON.stringify(import.meta.resolve("ws"))});
  const { createServer } = await import("node:http");
  const url = new URL(args.at(-1));
  const http = createServer((_request, response) => { response.writeHead(200); response.end("ok"); });
  const server = new WebSocketServer({ server: http });
  http.listen(Number(url.port), url.hostname);
  server.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw));
    socket.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  process.on("SIGTERM", () => process.exit(0));
  await report();
} else {
  await report();
}
`);
  await chmod(fake, 0o755);
  return fake;
}

function managedEnvironment(home, gatewayUrl) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CODEX_HOME: join(home, ".codex"),
    STATEWRIGHT_API_KEY: FAKE_KEY,
    STATEWRIGHT_REFRESH_TOKEN: FAKE_REFRESH,
    STATEWRIGHT_TELEMETRY_API_KEY: FAKE_TELEMETRY_KEY,
    STATEWRIGHT_GATEWAY_URL: gatewayUrl,
    STATEWRIGHT_NATIVE_TOKEN_TELEMETRY: "false",
    STATEWRIGHT_QWEN_ENABLED: "false",
    STATEWRIGHT_SENTRY_DISABLED: "true",
  };
}

function assertIsolated(results) {
  assert.ok(results.tokenFileProvided, "Codex must receive the bridge token file path");
  for (const scope of ["codex", "command"]) {
    assert.deepEqual(results[scope].credentialNames, [], `${scope} env must hold no Statewright credential names`);
    assert.equal(results[scope].fakeSecretInValues, false, `${scope} env must not carry a gateway credential under any name`);
    assert.equal(results[scope].bridgeTokenInValues, false, `${scope} env must not carry the bridge token`);
  }
  assert.equal(results.mcpReply, "gateway-authenticated", "the Statewright MCP connection must still authenticate");
}

async function waitForFile(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("managed codex exec: agent commands see no Statewright credentials while MCP authenticates", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-env-isolation-exec-"));
  const gateway = await fakeGateway();
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    const results = join(home, "results.json");
    const fake = await writeFakeCodex(home, results);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: ["exec", "probe"], cwd: home, home, pollMs: 5,
      environment: managedEnvironment(home, gateway.url),
      reporter: { async report() {}, setEnvironment() {} },
    }), 0);
    const recorded = await waitForFile(results);
    assertIsolated(recorded);
    const policy = recorded.args.indexOf("-c");
    assert.match(recorded.args[policy + 1], /^shell_environment_policy\.exclude=\[.*"STATEWRIGHT_\*API_KEY\*"/);
    assert.deepEqual(recorded.args.slice(policy + 2), ["exec", "probe"]);
    assert.ok(gateway.seen.authorized >= 1);
    assert.equal(gateway.seen.rejected, 0);
  } finally {
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resident App Server: the key travels by pipe and agent commands see no credentials", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-env-isolation-resident-"));
  const gateway = await fakeGateway();
  let manifest = null;
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    const results = join(home, "results.json");
    const fake = await writeFakeCodex(home, results);
    manifest = await ensureCodexAppServerResident({
      command: fake, cwd: home, home, clientId: "swc_0123456789abcdef0123456789abcdef",
      environment: managedEnvironment(home, gateway.url),
    });
    const recorded = await waitForFile(results);
    assertIsolated(recorded);
    const subcommand = recorded.args.indexOf("app-server");
    assert.ok(recorded.args.slice(0, subcommand).some(value => value.startsWith("shell_environment_policy.exclude=")));
    assert.ok(gateway.seen.authorized >= 1);
    assert.equal(gateway.seen.rejected, 0);
  } finally {
    if (manifest?.pid) {
      try { process.kill(manifest.pid, "SIGTERM"); } catch {}
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(manifest.pid, 0); } catch { break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
    }
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("bare and suffixed Statewright credential names are stripped; the client id is not a credential", () => {
  for (const name of ["STATEWRIGHT_TOKEN", "STATEWRIGHT_KEY", "STATEWRIGHT_SECRET", "STATEWRIGHT_APPROVAL_GRANT_KEY",
    "STATEWRIGHT_GATEWAY_BEARER", "STATEWRIGHT_OPERATOR_CREDENTIALS", "STATEWRIGHT_API_KEY_FILE"]) {
    assert.equal(isStatewrightCredentialEnvName(name), true, name);
  }
  for (const name of ["STATEWRIGHT_CLIENT_ID", "STATEWRIGHT_NATIVE_TOKEN_TELEMETRY", "STATEWRIGHT_GATEWAY_URL", "STATEWRIGHT_ROUTE_CONTROL_DIR"]) {
    assert.equal(isStatewrightCredentialEnvName(name), false, name);
  }
});

test("the shell policy always carries generic credential patterns and warns on an unreadable policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-shell-policy-generic-"));
  try {
    const policyList = async () => {
      let warned = 0;
      const [, value] = await codexShellEnvironmentPolicyArgs({ codexHome: home, warn: () => { warned += 1; } });
      return { list: JSON.parse(value.replace(/^shell_environment_policy\.exclude=/, "")), warned };
    };
    // No config at all: generic + Statewright patterns, no warning.
    let { list, warned } = await policyList();
    for (const pattern of [...GENERIC_SHELL_CREDENTIAL_EXCLUDES, "STATEWRIGHT_TOKEN", "STATEWRIGHT_*_KEY"]) assert.ok(list.includes(pattern), pattern);
    assert.equal(warned, 0);
    // An inline table the parser cannot read must not silently weaken the override.
    await writeFile(join(home, "config.toml"), 'shell_environment_policy = { inherit = "all", exclude = ["AWS_*"] }\n');
    ({ list, warned } = await policyList());
    assert.equal(warned, 1);
    for (const pattern of GENERIC_SHELL_CREDENTIAL_EXCLUDES) assert.ok(list.includes(pattern), pattern);
    // A readable table is unioned without a warning.
    await writeFile(join(home, "config.toml"), '[shell_environment_policy]\nexclude = ["AWS_*"]\n');
    ({ list, warned } = await policyList());
    assert.equal(warned, 0);
    assert.equal(list[0], "AWS_*");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("private control directories are tightened to 0700 even when they already exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-private-dir-"));
  try {
    const loose = join(root, "routes");
    await mkdir(loose, { mode: 0o755 });
    await chmod(loose, 0o755);
    await ensurePrivateDirectory(loose);
    assert.equal((await stat(loose)).mode & 0o777, 0o700);
    const created = await ensurePrivateDirectory(join(root, "a", "b"));
    assert.equal((await stat(created)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shell readers ignore a bridge token file that is group/other readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-token-perms-"));
  try {
    const token = join(root, "managed-mcp.token");
    await writeFile(token, "fake-bridge-token", { mode: 0o600 });
    const probe = (mode) => new Promise((resolveProbe) => {
      // Source only the reader block from the Claude MCP proxy; report a boolean.
      const script = `eval "$(sed -n '/^statewright_private_token_file()/,/^export -n STATEWRIGHT_MANAGED_MCP_BEARER/p' ${JSON.stringify(CLAUDE_MCP_PROXY)})"; [ -n "$STATEWRIGHT_MANAGED_MCP_BEARER" ] && echo loaded || echo ignored`;
      chmod(token, mode).then(() => {
        const child = spawn("/bin/bash", ["-c", script], { env: { PATH: process.env.PATH, STATEWRIGHT_MANAGED_MCP_TOKEN_FILE: token } });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.once("close", () => resolveProbe(out.trim()));
      });
    });
    assert.equal(await probe(0o600), "loaded");
    assert.equal(await probe(0o644), "ignored");
    assert.equal(await probe(0o640), "ignored");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A stand-in Claude Code. Like real Claude it (1) runs Bash-tool commands with
// its own full environment, and (2) launches stdio MCP servers (the legacy
// Statewright proxy) with that same environment. Names and booleans only.
async function writeFakeClaude(home, resultsPath) {
  const fake = join(home, "fake-claude.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const FAKE_SECRETS = ${JSON.stringify([FAKE_KEY, FAKE_REFRESH, FAKE_TELEMETRY_KEY])};
const tokenFile = process.env.STATEWRIGHT_MANAGED_MCP_TOKEN_FILE ?? null;
let bridgeToken = null;
try { bridgeToken = tokenFile ? readFileSync(tokenFile, "utf8") : null; } catch {}
const credentialLike = name => /^STATEWRIGHT_\\w*(API_KEY|_TOKEN|_KEY|SECRET|PASSWORD|BEARER)$/i.test(name) || /^STATEWRIGHT_\\w*REFRESH/i.test(name);
function inspect(env) {
  const values = Object.values(env).map(String);
  return {
    credentialNames: Object.keys(env).filter(credentialLike).sort(),
    fakeSecretInValues: values.some(value => FAKE_SECRETS.some(secret => value.includes(secret))),
    bridgeTokenInValues: Boolean(bridgeToken) && values.some(value => value.includes(bridgeToken)),
  };
}
// A Bash-tool command: a POSIX shell whose child dumps the env it inherited.
const shell = spawnSync("/bin/sh", ["-c", 'exec "$0" -e "process.stdout.write(JSON.stringify(process.env))"', process.execPath], { env: process.env, encoding: "utf8" });
const shellEnv = JSON.parse(shell.stdout || "{}");
async function mcpRoundTrip() {
  const proxy = spawn("/bin/bash", [${JSON.stringify(CLAUDE_MCP_PROXY)}], { env: process.env, cwd: process.env.HOME });
  let out = "";
  proxy.stdout.on("data", chunk => { out += chunk; });
  proxy.stderr.resume();
  const closed = new Promise(resolveClose => proxy.once("close", resolveClose));
  proxy.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
  ].map(value => JSON.stringify(value)).join("\\n") + "\\n");
  await closed;
  const reply = out.trim().split("\\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(value => value?.id === 2);
  return reply?.result?.content?.[0]?.text ?? null;
}
const modes = tokenFile ? { file: statSync(tokenFile).mode & 0o777, dir: statSync(dirname(tokenFile)).mode & 0o777 } : null;
writeFileSync(${JSON.stringify(resultsPath)}, JSON.stringify({
  tokenFileProvided: Boolean(tokenFile),
  modes,
  claude: inspect(process.env),
  command: inspect(shellEnv),
  mcpReply: await mcpRoundTrip(),
}));
`);
  await chmod(fake, 0o755);
  return fake;
}

test("managed Claude: Bash-tool shells see no Statewright credentials while MCP authenticates", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-env-isolation-claude-"));
  const gateway = await fakeGateway();
  try {
    const results = join(home, "results.json");
    const fake = await writeFakeClaude(home, results);
    const environment = { ...managedEnvironment(home, gateway.url), STATEWRIGHT_MANAGED_MCP_TOKEN: "FAKE-stale-parent-bridge" };
    delete environment.CODEX_HOME;
    assert.equal(await runManagedClient({
      host: "claude", command: fake, args: ["--permission-mode", "default"], cwd: home, home, pollMs: 5,
      environment, reporter: { async report() {}, setEnvironment() {} },
    }), 0);
    const recorded = await waitForFile(results);
    assert.ok(recorded.tokenFileProvided, "Claude must receive the bridge token file path");
    assert.deepEqual(recorded.modes, { file: 0o600, dir: 0o700 });
    for (const scope of ["claude", "command"]) {
      assert.deepEqual(recorded[scope].credentialNames, [], `${scope} env must hold no Statewright credential names`);
      assert.equal(recorded[scope].fakeSecretInValues, false, `${scope} env must not carry a gateway credential under any name`);
      assert.equal(recorded[scope].bridgeTokenInValues, false, `${scope} env must not carry the bridge token`);
    }
    assert.equal(recorded.mcpReply, "gateway-authenticated", "the Statewright MCP connection must still authenticate");
    assert.ok(gateway.seen.authorized >= 1);
    assert.equal(gateway.seen.rejected, 0);
    assert.deepEqual(managedAgentEnvironment({ STATEWRIGHT_API_KEY: FAKE_KEY, PATH: "/bin" }, { tokenFile: "/tmp/t" }),
      { PATH: "/bin", STATEWRIGHT_MANAGED_MCP_TOKEN_FILE: "/tmp/t" });
  } finally {
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed Codex TUI attached to its resident: the TUI and its commands see no credentials", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-env-isolation-tui-"));
  const gateway = await fakeGateway();
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    const results = join(home, "results.json");
    const fake = await writeFakeCodex(home, results);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: [], cwd: home, home, pollMs: 5,
      environment: managedEnvironment(home, gateway.url),
      reporter: { async report() {}, setEnvironment() {} },
    }), 0);
    const tui = await waitForFile(`${results}.tui`);
    assert.equal(tui.args[0], "--remote");
    for (const scope of ["codex", "command"]) {
      assert.deepEqual(tui[scope].credentialNames, [], `TUI ${scope} env must hold no Statewright credential names`);
      assert.equal(tui[scope].fakeSecretInValues, false, `TUI ${scope} env must not carry a gateway credential under any name`);
    }
    // The resident it attached to is isolated as well and still authenticates.
    assertIsolated(await waitForFile(results));
  } finally {
    const { readdir } = await import("node:fs/promises");
    const residents = join(home, ".statewright", "codex-app-server");
    for (const entry of await readdir(residents).catch(() => [])) {
      const manifest = await readFile(join(residents, entry, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!manifest?.pid) continue;
      try { process.kill(manifest.pid, "SIGTERM"); } catch {}
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(manifest.pid, 0); } catch { break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
    }
    await gateway.close();
    await rm(home, { recursive: true, force: true });
  }
});
