import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const STATEWRIGHT_CONFIG_RELATIVE_PATH = join(".statewright", "config.json");
export const CODEX_OTEL_FRAGMENT = `# Managed by Statewright. Set .statewright/config.json telemetry.codex.native_tokens to false to stop managing this exporter.\n[otel]\nenvironment = "statewright"\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json", headers = {} } }\ntrace_exporter = "none"\nmetrics_exporter = "none"\n`;

function enabledFromRawConfig(raw) {
  return raw?.telemetry?.codex?.native_tokens === true;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findStatewrightConfig(startDirectory, { homeDirectory = homedir() } = {}) {
  let directory = resolve(startDirectory);
  while (true) {
    const configPath = join(directory, STATEWRIGHT_CONFIG_RELATIVE_PATH);
    if (await isFile(configPath)) return configPath;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const userConfigPath = join(homeDirectory, ".statewright", "config.json");
  return (await isFile(userConfigPath)) ? userConfigPath : null;
}

export async function nativeCodexTokenTelemetryEnabled(startDirectory, options) {
  const configPath = await findStatewrightConfig(startDirectory, options);
  if (!configPath) return { enabled: false, configPath: null };
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return { enabled: enabledFromRawConfig(raw), configPath };
  } catch (error) {
    return {
      enabled: false,
      configPath,
      error: `Statewright config is not valid JSON: ${error.message}`,
    };
  }
}

function statewrightOtelTable(text) {
  const start = text.search(/^\[otel\]\s*$/m);
  if (start < 0) return false;
  const after = text.slice(start);
  const nextTable = after.slice(1).search(/\n\[[^\]]+\]\s*(?:\n|$)/);
  const table = nextTable < 0 ? after : after.slice(0, nextTable + 1);
  return table.includes('environment = "statewright"')
    && table.includes("http://127.0.0.1:4318/v1/logs")
    && table.includes("log_user_prompt = false");
}

export function planCodexOtelConfig(existing, enabled) {
  if (!enabled) return { action: "disabled", content: existing };
  if (!/^\[otel\]/m.test(existing)) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return { action: "created", content: `${existing}${separator}${CODEX_OTEL_FRAGMENT}` };
  }
  if (statewrightOtelTable(existing)) return { action: "already_enabled", content: existing };
  return { action: "conflict", content: existing };
}

export async function bootstrapCodexOtelConfig({ projectDirectory, codexConfigPath, homeDirectory }) {
  const configuration = await nativeCodexTokenTelemetryEnabled(projectDirectory, { homeDirectory });
  if (!configuration.enabled) return { ...configuration, action: "disabled" };

  let existing = "";
  try {
    existing = await readFile(codexConfigPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const plan = planCodexOtelConfig(existing, true);
  if (plan.action !== "created") return { ...configuration, ...plan };

  await mkdir(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
  const temporary = `${codexConfigPath}.statewright-${process.pid}.tmp`;
  await writeFile(temporary, plan.content, { mode: 0o600 });
  await rename(temporary, codexConfigPath);
  return { ...configuration, ...plan, restart_required: true };
}
