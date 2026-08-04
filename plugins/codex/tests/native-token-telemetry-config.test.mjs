import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bootstrapCodexOtelConfig,
  CODEX_OTEL_FRAGMENT,
  nativeCodexTokenTelemetryEnabled,
  planCodexOtelConfig,
} from "../scripts/lib/native-token-telemetry-config.mjs";

async function projectConfig(root, value) {
  await mkdir(join(root, ".statewright"), { recursive: true });
  await writeFile(join(root, ".statewright", "config.json"), JSON.stringify(value));
}

test("native Codex telemetry is dormant without explicit Statewright configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-otel-config-"));
  const result = await nativeCodexTokenTelemetryEnabled(root);
  assert.deepEqual(result, { enabled: false, configPath: null });
});

test("native Codex telemetry inherits an explicit project opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-otel-config-"));
  await projectConfig(root, { telemetry: { codex: { native_tokens: true } } });
  const result = await nativeCodexTokenTelemetryEnabled(join(root, "src", "nested"));
  assert.equal(result.enabled, true);
  assert.match(result.configPath, /[.]statewright[\\/]config[.]json$/);
});

test("Codex OTel bootstrap creates only a Statewright-managed missing table", () => {
  const plan = planCodexOtelConfig("[features]\nhooks = true\n", true);
  assert.equal(plan.action, "created");
  assert.match(plan.content, /^\[features\]/);
  assert.match(plan.content, /log_user_prompt = false/);
  assert.match(plan.content, /127[.]0[.]0[.]1:4318/);
});

test("Codex OTel bootstrap is idempotent and preserves user-owned OTel settings", () => {
  assert.equal(planCodexOtelConfig(CODEX_OTEL_FRAGMENT, true).action, "already_enabled");
  const conflicting = '[otel]\nenvironment = "vendor"\n';
  const plan = planCodexOtelConfig(conflicting, true);
  assert.equal(plan.action, "conflict");
  assert.equal(plan.content, conflicting);
});

test("explicit project opt-in bootstraps Codex configuration once", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-otel-config-"));
  const codexConfigPath = join(root, "codex", "config.toml");
  await projectConfig(root, { telemetry: { codex: { native_tokens: true } } });
  const created = await bootstrapCodexOtelConfig({ projectDirectory: root, codexConfigPath });
  assert.equal(created.action, "created");
  assert.equal(created.restart_required, true);
  const repeated = await bootstrapCodexOtelConfig({ projectDirectory: root, codexConfigPath });
  assert.equal(repeated.action, "already_enabled");
  assert.equal((await readFile(codexConfigPath, "utf8")).includes("log_user_prompt = false"), true);
});
