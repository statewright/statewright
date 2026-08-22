import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedClient } from "../lib/managed-client-supervisor.mjs";

if (process.platform !== "win32") {
  throw new Error("The Windows managed-client route canary must run on a Windows runner.");
}

function fakeBridgeFactory() {
  return {
    url: "http://127.0.0.1:9999",
    token: "windows-route-canary",
    async start() { return this; },
    async close() {},
  };
}

const root = await mkdtemp(join(tmpdir(), "statewright-windows-managed-route-"));
const home = join(root, "home");
const fixture = join(root, "managed-client-fixture.mjs");
const launcher = join(root, "fake-codex.cmd");
const calls = join(root, "calls.log");

try {
  await writeFile(fixture, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const calls = ${JSON.stringify(calls)};
const control = process.env.STATEWRIGHT_ROUTE_CONTROL_DIR;
appendFileSync(calls, JSON.stringify({
  args: process.argv.slice(2),
  client_id: process.env.STATEWRIGHT_CLIENT_ID,
  bridge_url: process.env.STATEWRIGHT_MANAGED_MCP_URL,
  bridge_token: process.env.STATEWRIGHT_MANAGED_MCP_TOKEN,
  control_dir: control,
}) + "\\n");
const marker = join(control, "route-written");
if (!existsSync(marker)) {
  writeFileSync(marker, "");
  writeFileSync(join(control, "route.json"), JSON.stringify({
    session_id: "windows-route-session",
    client_id: process.env.STATEWRIGHT_CLIENT_ID,
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
  }));
  // Force the supervisor through Windows process-tree escalation after its
  // initial graceful SIGINT request.
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
} else if (!process.argv.includes("resume")) {
  process.exit(2);
}
`);
  await chmod(fixture, 0o755);
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);

  const result = await runManagedClient({
    host: "codex",
    command: launcher,
    args: ["--full-auto"],
    environment: { ...process.env, STATEWRIGHT_API_KEY: "test" },
    home,
    cwd: root,
    pollMs: 5,
    bridgeFactory: fakeBridgeFactory,
  });
  assert.equal(result, 0, "the managed .cmd launcher must exit cleanly after its routed restart");
  const invocations = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(invocations.length, 2, "the .cmd launcher must run once before and once after routing");
  assert.ok(invocations[0].args.includes("--full-auto"));
  // cmd.exe removes quoting used to preserve the original argument boundary.
  // The receiving client still gets the same key/value argument.
  assert.deepEqual(invocations[1].args.slice(0, 8), ["-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high", "--full-auto", "resume", "windows-route-session", "Continue the active Statewright workflow in its current state. Use statewright_get_state first."]);
  assert.equal(invocations[0].client_id, invocations[1].client_id, "managed identity must survive the routed restart");
  assert.match(invocations[0].client_id, /^swc_[a-f0-9]{32}$/);
  assert.equal(invocations[0].bridge_url, "http://127.0.0.1:9999");
  assert.equal(invocations[1].bridge_url, invocations[0].bridge_url, "managed bridge URL must survive the routed restart");
  assert.equal(invocations[0].bridge_token, "windows-route-canary");
  assert.equal(invocations[1].bridge_token, invocations[0].bridge_token, "managed bridge token must survive the routed restart");
  assert.equal(invocations[1].control_dir, invocations[0].control_dir, "the routed child must reuse the same control directory");
  await assert.rejects(access(invocations[0].control_dir), { code: "ENOENT" }, "the control directory must be removed after the supervisor exits");
  console.log("Windows managed-client route canary passed for a .cmd launcher.");
} finally {
  await rm(root, { recursive: true, force: true });
}
