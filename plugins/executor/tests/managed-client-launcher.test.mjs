import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killProjectAppServers } from "../statewright-managed-client.mjs";
import { codexResumeInvocation } from "../lib/managed-client-supervisor.mjs";

function writable() {
  let value = "";
  return { write(chunk) { value += chunk; }, get value() { return value; } };
}

test("a missing gateway credential cannot silently launch an unmanaged resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-missing-resume-key-"));
  const home = join(root, "home");
  const helper = join(root, "missing-credential.mjs");
  const binary = join(root, "fake-codex.mjs");
  const marker = join(root, "codex-launched");
  try {
    await mkdir(join(home, ".statewright"), { recursive: true });
    await writeFile(join(home, ".statewright", "config.json"), JSON.stringify({
      routing: { managed_clients: { enabled: true, hosts: { codex: true } } },
    }));
    await writeFile(join(home, ".statewright", "environments.json"), JSON.stringify({
      gateways: { staging: { gateway_url: "https://staging.example/mcp", auth_url: "https://auth.example" } },
    }));
    await writeFile(helper, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:false,status:"missing"}));\n');
    await writeFile(binary, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "launched");\n`);
    await chmod(helper, 0o700);
    await chmod(binary, 0o700);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(STATEWRIGHT_|CODEX_)/.test(name)));
    Object.assign(env, { HOME: home, STATEWRIGHT_ENV: "staging", STATEWRIGHT_CREDENTIAL_HELPER: helper,
      STATEWRIGHT_SENTRY_DISABLED: "true" });
    const invoke = async args => {
      const child = spawn(process.execPath, [resolve("plugins/executor/statewright-managed-client.mjs"),
        "--host", "codex", "--real-bin", binary, "--", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      const code = await new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
      return { code, stderr };
    };
    for (const args of [["resume", "thread-1"], ["resume", "--last"]]) {
      const result = await invoke(args);
      assert.equal(result.code, 3);
      assert.match(result.stderr, /Cannot resume a managed Codex thread.*statewright_connect/);
      assert.equal(await access(marker).then(() => true, () => false), false);
    }
    assert.equal((await invoke([])).code, 0, "a first launch still supports browser onboarding");
    await access(marker);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume classification follows Codex command grammar", () => {
  assert.equal(codexResumeInvocation("codex", ["resume", "thread-1"]), true);
  assert.equal(codexResumeInvocation("codex", ["-m", "resume", "resume", "thread-1"]), true);
  assert.equal(codexResumeInvocation("codex", ["-m", "resume", "fix it"]), false);
  assert.equal(codexResumeInvocation("codex", ["--", "resume", "thread-1"]), false);
  assert.equal(codexResumeInvocation("claude", ["resume", "thread-1"]), false);
});

test("managed App Server termination selects one explicit same-cwd thread", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-kill-one-"));
  const root = join(home, ".statewright", "codex-app-server");
  const cwd = "/workspace/shared";
  const alpha = "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const beta = "swc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const input = { once(_event, callback) { callback("y"); } };
  const output = writable();
  const errorOutput = writable();
  const killed = [];
  try {
    for (const [clientId, threadId, pid] of [[alpha, "alpha-thread", 1111], [beta, "beta-thread", 2222]]) {
      const clientRoot = join(root, clientId);
      await mkdir(join(clientRoot, "routes"), { recursive: true });
      await writeFile(join(clientRoot, "manifest.json"), JSON.stringify({ pid, clientId, threadListCwd: cwd }));
      await writeFile(join(clientRoot, "routes", "codex-root-session.json"), JSON.stringify({ version: 1, session_id: threadId, client_id: clientId }));
    }
    const result = await killProjectAppServers({
      cwd,
      home,
      threadId: "alpha-thread",
      input,
      output,
      errorOutput,
      kill(pid, signal) { killed.push([pid, signal]); },
    });
    assert.deepEqual(result, [1111]);
    assert.deepEqual(killed, [[1111, "SIGTERM"]]);
    assert.match(errorOutput.value, /thread=alpha-thread/);
    assert.doesNotMatch(errorOutput.value, /beta-thread/);
    assert.match(output.value, /"threadId":"alpha-thread"/);
    const noMatch = await killProjectAppServers({
      cwd,
      home,
      threadId: "missing-thread",
      input,
      output,
      errorOutput,
      kill(pid) { killed.push([pid, "unexpected"]); },
    });
    assert.deepEqual(noMatch, []);
    assert.equal(killed.length, 1);
    assert.match(errorOutput.value, /nothing was terminated/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
