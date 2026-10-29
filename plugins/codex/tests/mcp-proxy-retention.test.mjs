import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { installManagedClientShim } from "../../executor/lib/managed-client-supervisor.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "statewright-proxy-retention-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = join(home, "cache", "plugin");
  await cp(resolve("plugins/codex"), plugin, { recursive: true,
    filter: path => !path.split("/").includes("node_modules") });
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const rpc = JSON.parse(raw);
    calls.push({ rpc, client: req.headers["x-statewright-client-id"], authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "owned-ok" }] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function start(client = "swc_one", script = join(plugin, "mcp-proxy.sh")) {
    const child = spawn("/bin/bash", [script], { cwd: dirname(script), env: {
      PATH: process.env.PATH, HOME: home, STATEWRIGHT_NODE_BIN: process.execPath,
      STATEWRIGHT_MANAGED_CLIENT_HOST: "codex", STATEWRIGHT_CLIENT_ID: client,
      STATEWRIGHT_MANAGED_MCP_URL: `http://127.0.0.1:${server.address().port}`,
      STATEWRIGHT_MANAGED_MCP_TOKEN: client + "-fixture-token",
    } });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const waiting = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => { const value = JSON.parse(line); waiting.get(value.id)?.(value); });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => { child.kill(); await closed; lines.close(); });
    let id = 0;
    async function request(method, params = {}) {
      const next = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(next); reject(new Error("proxy timeout: " + stderr)); }, 5000);
        waiting.set(next, value => { clearTimeout(timer); waiting.delete(next); resolve(value); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
      });
    }
    await request("initialize");
    return { request, child };
  }
  async function snapshots() {
    const root = join(home, ".statewright", "runtime", "codex-mcp");
    return (await readdir(root)).filter(n => !n.startsWith(".")).map(n => join(root, n, "mcp-proxy.sh"));
  }
  return { home, plugin, calls, start, snapshots };
}

test("live MCP proxy survives cache eviction without reconnecting or replaying", async t => {
  const f = await fixture(t);
  const proxy = await f.start();
  await rm(f.plugin, { recursive: true });
  const before = f.calls.length;
  const reply = await proxy.request("tools/call", { name: "statewright_get_state", arguments: {} });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.content[0].text, "owned-ok");
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1).client, "swc_one");
});

test("concurrent proxies retain separate bindings when their shared cache disappears", async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.start("swc_one"), f.start("swc_two")]);
  await rm(f.plugin, { recursive: true });
  const before = f.calls.length;
  for (const proxy of [one, two]) {
    const reply = await proxy.request("tools/call", { name: "statewright_get_state", arguments: {} });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  }
  assert.deepEqual(f.calls.slice(before).map(c => [c.client, c.authorization]), [
    ["swc_one", "Bearer swc_one-fixture-token"], ["swc_two", "Bearer swc_two-fixture-token"],
  ]);
  assert.equal((await f.snapshots()).length, 1);
});

test("a new cache version never replaces a live snapshot; retained entry can cold-start", async t => {
  const f = await fixture(t);
  const first = await f.start();
  const [oldEntry] = await f.snapshots();
  const oldBytes = await readFile(oldEntry, "utf8");
  const manifestPath = join(f.plugin, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "0.3.5+retention-next" }));
  const second = await f.start("swc_two");
  assert.equal((await f.snapshots()).length, 2);
  assert.equal(await readFile(oldEntry, "utf8"), oldBytes);
  await rm(f.plugin, { recursive: true });
  const cold = await f.start("swc_cold", oldEntry);
  for (const proxy of [first, second, cold]) {
    assert.equal((await proxy.request("tools/call", { name: "statewright_get_state" })).error, undefined);
  }
  assert.deepEqual(f.calls.filter(c => c.rpc.method === "tools/call").map(c => c.client), ["swc_one", "swc_two", "swc_cold"]);
});

test("tampered retained runtime is not overwritten or adopted on cold-start", async t => {
  const f = await fixture(t);
  await f.start();
  const [entry] = await f.snapshots();
  await writeFile(join(dirname(entry), "mcp-tool-catalog.json"), "[]\n");
  const before = f.calls.length;
  const cold = await f.start("swc_cold", entry);
  const reply = await cold.request("tools/call", { name: "statewright_get_state" });
  assert.equal(reply.error.data.reason, "snapshot_verification_failed");
  assert.equal(reply.error.data.upstreamOutcome, "not_forwarded");
  assert.equal(f.calls.length, before);
  assert.equal((await f.snapshots()).length, 1);
  assert.equal(await readFile(join(dirname(entry), "mcp-tool-catalog.json"), "utf8"), "[]\n");
});

test("missing startup helper is actionable and forwards no request", async t => {
  const f = await fixture(t);
  await rm(join(f.plugin, "scripts", "persist-mcp-runtime.mjs"));
  const proxy = await f.start();
  const reply = await proxy.request("tools/call", { name: "statewright_transition" });
  assert.equal(reply.error.data.reason, "snapshot_helper_missing");
  assert.equal(reply.error.data.upstreamOutcome, "not_forwarded");
  assert.equal(reply.error.data.retryAllowed, false);
  assert.equal(f.calls.length, 0);
});

test("response helper failure reports unknown upstream outcome without replay", async t => {
  const f = await fixture(t);
  const proxy = await f.start();
  const [entry] = await f.snapshots();
  await rm(join(dirname(entry), "scripts/lib/desktop-runtime/mcp-recovery.mjs"));
  const before = f.calls.length;
  const reply = await proxy.request("tools/call", { name: "statewright_transition" });
  assert.equal(reply.error.data.reason, "response_helper_missing");
  assert.equal(reply.error.data.upstreamOutcome, "unknown");
  assert.equal(reply.error.data.retryAllowed, false);
  assert.equal(f.calls.length, before + 1);
});

test("retained MCP package remains complete for standalone managed-launcher bootstrap", async t => {
  const f = await fixture(t);
  await f.start();
  const [entry] = await f.snapshots();
  const root = dirname(entry);
  const assets = [".mcp.json", ".codex-plugin/plugin.json", "hooks/hooks.json", "hook.sh", "capture.sh",
    "tool-policy.sh", "scripts/statewright-managed-client.mjs", "scripts/executor-hook.mjs"];
  const expected = new Map(await Promise.all(assets.map(async name => [name, await readFile(join(f.plugin, name), "utf8")])));
  await rm(f.plugin, { recursive: true });
  const installed = await installManagedClientShim({ host: "codex", home: f.home,
    launcherPath: join(root, "scripts/statewright-managed-client.mjs"), realBinary: process.execPath });
  const managedRoot = dirname(dirname(installed.launcherPath));
  for (const name of assets) {
    assert.equal(await readFile(join(root, name), "utf8"), expected.get(name), name);
    assert.equal(await readFile(join(managedRoot, name), "utf8"), expected.get(name), name);
  }
});
