import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CredentialStoreError, getGatewayCredential, resolveGatewayApiKey, resolveTuiGatewayApiKey, setGatewayCredential, unlockMacKeychain } from "../lib/credential-store.mjs";
import { codexOneShotInvocation } from "../lib/managed-client-supervisor.mjs";
import { managedClientTuiInvocation } from "../statewright-managed-client.mjs";

async function fixtureHelper(home) {
  const helper = join(home, "credential-helper.mjs");
  const database = join(home, "database.json");
  await writeFile(helper, `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let values = {};
try { values = JSON.parse(readFileSync(process.env.FIXTURE_DATABASE, "utf8")); } catch {}
const account = "v1:" + createHash("sha256").update(request.gateway).digest("hex");
if (request.operation === "set") { values[account] = request.secret; writeFileSync(process.env.FIXTURE_DATABASE, JSON.stringify(values)); console.log(JSON.stringify({ok:true,status:"ok",account})); }
else if (request.operation === "get" && values[account]) console.log(JSON.stringify({ok:true,status:"ok",account,secret:values[account]}));
else console.log(JSON.stringify({ok:false,status:"missing",account}));
`);
  await chmod(helper, 0o700);
  return { helper, database };
}

test("Node adapter keeps credentials isolated by canonical gateway", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-credential-adapter-"));
  const { helper, database } = await fixtureHelper(home);
  const environment = { PATH: process.env.PATH, STATEWRIGHT_CREDENTIAL_HELPER: helper, FIXTURE_DATABASE: database };
  await setGatewayCredential("https://prod.example", "prod-secret", { environment, home });
  await setGatewayCredential("https://stage.example/mcp/", "stage-secret", { environment, home });
  assert.equal(await getGatewayCredential("https://prod.example/mcp", { environment, home }), "prod-secret");
  assert.equal(await getGatewayCredential("https://stage.example", { environment, home }), "stage-secret");
  const stored = JSON.stringify(JSON.parse(await readFile(database, "utf8")));
  assert.match(stored, /prod-secret/);
  assert.match(stored, /stage-secret/);
});

test("explicit process credential wins and missing helper is typed", async () => {
  assert.equal(await resolveGatewayApiKey({ STATEWRIGHT_API_KEY: " explicit " }), "explicit");
  await assert.rejects(
    getGatewayCredential("https://example.test", {
      environment: { PATH: process.env.PATH, STATEWRIGHT_CREDENTIAL_HELPER: "/definitely/missing/statewright-credentials" },
    }),
    (error) => error instanceof CredentialStoreError && error.code === "CREDENTIAL_HELPER_MISSING",
  );
});

test("legacy credential migrates only to production", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-credential-migrate-"));
  const { helper, database } = await fixtureHelper(home);
  await mkdir(join(home, ".statewright"), { recursive: true });
  await writeFile(join(home, ".statewright", "api_key"), "legacy-production\n", { mode: 0o600 });
  const base = { PATH: process.env.PATH, STATEWRIGHT_CREDENTIAL_HELPER: helper, FIXTURE_DATABASE: database };
  assert.equal(await resolveGatewayApiKey(base, home), "legacy-production");
  await assert.rejects(
    resolveGatewayApiKey({ ...base, STATEWRIGHT_GATEWAY_URL: "https://staging.example" }, home),
    (error) => error.code === "CREDENTIAL_MISSING",
  );
});

function unavailable() {
  return new CredentialStoreError("OS credential store could not read this gateway credential", "CREDENTIAL_STORE_UNAVAILABLE");
}

test("macOS TUI unlocks via the fixed system executable without a password argument", async () => {
  const calls = [];
  const unlocked = await unlockMacKeychain({ spawnProcess(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  } });
  assert.equal(unlocked, true);
  assert.deepEqual(calls, [{
    command: "/usr/bin/security",
    args: ["unlock-keychain"],
    options: { stdio: "inherit", shell: false },
  }]);
});

test("macOS TUI asks before unlocking and retries the same gateway lookup exactly once", async () => {
  let lookups = 0;
  let prompts = 0;
  let unlocks = 0;
  let written = "";
  const result = await resolveTuiGatewayApiKey({ STATEWRIGHT_ENV: "staging" }, {
    platform: "darwin",
    input: { isTTY: true },
    output: { isTTY: true, write(value) { written += value; } },
    lookup: async (environment) => {
      assert.equal(environment.STATEWRIGHT_ENV, "staging");
      if (++lookups === 1) throw unavailable();
      return "fixture-secret";
    },
    confirm: async () => { prompts++; return true; },
    unlock: async () => { unlocks++; return true; },
  });
  assert.equal(result, "fixture-secret");
  assert.deepEqual([lookups, prompts, unlocks], [2, 1, 1]);
  assert.match(written, /could not read this gateway credential/);
  assert.doesNotMatch(written, /fixture-secret/);
});

test("one-shot Codex and Claude commands with TTY streams never offer keychain unlock", async () => {
  assert.equal(codexOneShotInvocation("codex", ["exec", "echo hello"]), true);
  assert.equal(managedClientTuiInvocation("codex", ["resume", "fixture-thread"]), true);
  assert.equal(managedClientTuiInvocation("claude", []), true);
  for (const [host, args] of [
    ["codex", ["exec", "echo hello"]],
    ["claude", ["-p", "echo hello"]],
    ["claude", ["--print", "echo hello"]],
  ]) {
    let prompts = 0;
    await assert.rejects(resolveTuiGatewayApiKey({}, {
      platform: "darwin",
      allowUnlock: managedClientTuiInvocation(host, args),
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      lookup: async () => { throw unavailable(); },
      confirm: async () => { prompts++; return true; },
    }), (error) => error.code === "CREDENTIAL_STORE_UNAVAILABLE");
    assert.equal(prompts, 0);
  }
});

test("interactive confirmation accepts only an explicit yes through readline", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let prompt = "";
  let answered = false;
  output.on("data", (chunk) => {
    prompt += chunk.toString();
    if (!answered && prompt.includes("[y/N] ")) {
      answered = true;
      input.write("yes\n");
    }
  });
  let lookups = 0;
  const result = await resolveTuiGatewayApiKey({}, {
    platform: "darwin",
    input,
    output,
    lookup: async () => { if (++lookups === 1) throw unavailable(); return "fixture-secret"; },
    unlock: async () => true,
  });
  assert.equal(result, "fixture-secret");
  assert.equal(lookups, 2);
  assert.match(prompt, /macOS default keychain/);
  assert.doesNotMatch(prompt, /fixture-secret/);
  input.destroy();
  output.destroy();
});

test("TUI unlock never runs for missing keys, noninteractive macOS, Linux, or Windows", async () => {
  for (const [platform, input, failure] of [
    ["darwin", { isTTY: true }, new CredentialStoreError("missing", "CREDENTIAL_MISSING")],
    ["darwin", { isTTY: false }, unavailable()],
    ["linux", { isTTY: true }, unavailable()],
    ["win32", { isTTY: true }, unavailable()],
  ]) {
    let prompts = 0;
    let unlocks = 0;
    await assert.rejects(resolveTuiGatewayApiKey({}, {
      platform,
      input,
      output: { isTTY: true, write() {} },
      lookup: async () => { throw failure; },
      confirm: async () => { prompts++; return true; },
      unlock: async () => { unlocks++; return true; },
    }), (error) => error.code === failure.code);
    assert.deepEqual([prompts, unlocks], [0, 0]);
  }
});

test("declined or failed unlock stops without retrying or exposing a credential", async () => {
  for (const [approved, unlockSucceeded, expectedCode] of [
    [false, false, "CREDENTIAL_UNLOCK_CANCELLED"],
    [true, false, "CREDENTIAL_UNLOCK_FAILED"],
  ]) {
    let lookups = 0;
    await assert.rejects(resolveTuiGatewayApiKey({}, {
      platform: "darwin",
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      lookup: async () => { lookups++; throw unavailable(); },
      confirm: async () => approved,
      unlock: async () => unlockSucceeded,
    }), (error) => error.code === expectedCode);
    assert.equal(lookups, 1);
  }
});

test("post-unlock lookup fails closed and preserves a genuinely missing credential", async () => {
  for (const [retryError, expectedCode] of [
    [unavailable(), "CREDENTIAL_STORE_UNAVAILABLE"],
    [new CredentialStoreError("missing", "CREDENTIAL_MISSING"), "CREDENTIAL_MISSING"],
  ]) {
    let lookups = 0;
    await assert.rejects(resolveTuiGatewayApiKey({}, {
      platform: "darwin",
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      lookup: async () => { if (++lookups === 1) throw unavailable(); throw retryError; },
      confirm: async () => true,
      unlock: async () => true,
    }), (error) => error.code === expectedCode);
    assert.equal(lookups, 2);
  }
});
