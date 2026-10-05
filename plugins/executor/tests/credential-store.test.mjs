import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStoreError, getGatewayCredential, resolveGatewayApiKey, setGatewayCredential } from "../lib/credential-store.mjs";

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
