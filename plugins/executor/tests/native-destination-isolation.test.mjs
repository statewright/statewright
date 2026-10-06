import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { codexNativeDestinationInvocation, nativeDestinationEnvironment } from "../lib/managed-client-supervisor.mjs";

test("destination grammar does not reinterpret prompts or model/config values", () => {
  for (const argv of [["--remote", "ws://localhost:1", "resume", "one"], ["resume", "one", "--remote=ws://localhost:2"], ["app-server", "daemon", "start"], ["agents"], ["plugin", "list"], ["--help"]]) assert.equal(codexNativeDestinationInvocation("codex", argv), true, JSON.stringify(argv));
  for (const argv of [[], ["resume", "one"], ["exec", "fix app-server"], ["--", "--remote"], ["-m", "--remote", "resume", "one"], ["-c", "x=--remote", "resume", "one"]]) assert.equal(codexNativeDestinationInvocation("codex", argv), false, JSON.stringify(argv));
});
test("native destination retains tenant and target options, not invoking server capabilities", () => {
  const env = nativeDestinationEnvironment({ PATH: "/bin", CODEX_HOME: "/tenant/home", CODEX_THREAD_ID: "old", STATEWRIGHT_API_KEY: "old", STATEWRIGHT_ADAPTER_TOKEN: "old", STATEWRIGHT_ADAPTER_URL: "old", STATEWRIGHT_MANAGED_MCP_TOKEN: "old", STATEWRIGHT_MANAGED_MCP_URL: "old", STATEWRIGHT_CLIENT_ID: "old", STATEWRIGHT_CODEX_RESIDENT_ROOT: "old" });
  assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/tenant/home" });
});
test("actual shim entry preserves two native destinations without provisioning a third server", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-native-destinations-"));
  try {
    const binary = join(root, "codex"), output = join(root, "calls.jsonl");
    await writeFile(binary, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2),key:!!process.env.STATEWRIGHT_API_KEY,bridge:!!process.env.STATEWRIGHT_MANAGED_MCP_URL,thread:!!process.env.CODEX_THREAD_ID})+'\\n');\n`);
    await chmod(binary, 0o700);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STATEWRIGHT_|CODEX_)/i.test(key)));
    Object.assign(env, { HOME: root, STATEWRIGHT_API_KEY: "parent", STATEWRIGHT_MANAGED_MCP_URL: "http://localhost:1", CODEX_THREAD_ID: "parent", STATEWRIGHT_SENTRY_DISABLED: "true" });
    const calls = [["--remote", "ws://127.0.0.1:1111", "resume", "a"], ["--remote", "ws://127.0.0.1:2222", "resume", "b"], ["app-server", "daemon", "start"]];
    for (const args of calls) {
      const child = spawn(process.execPath, [resolve("plugins/executor/statewright-managed-client.mjs"), "--host", "codex", "--real-bin", binary, "--", ...args], { env, stdio: "pipe" });
      let stderr = ""; child.stderr.on("data", d => stderr += d);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const code = await new Promise((r, reject) => { child.on("error", reject); child.on("close", r); }); clearTimeout(timer);
      assert.equal(code, 0, stderr);
    }
    assert.deepEqual((await readFile(output, "utf8")).trim().split("\n").map(JSON.parse), calls.map(args => ({ args, key: false, bridge: false, thread: false })));
  } finally { await rm(root, { recursive: true, force: true }); }
});
