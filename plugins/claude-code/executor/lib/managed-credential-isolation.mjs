import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Managed Codex processes run arbitrary agent commands. Those commands, and
// any test they start, inherit the Codex process environment, so no gateway
// credential may ever live there. The supervisor/resident keeps the gateway
// key in memory; the local MCP bridge token reaches the Statewright MCP proxy
// and hooks through a 0600 file in the owner's 0700 control directory.
export const MANAGED_MCP_TOKEN_FILE_ENV = "STATEWRIGHT_MANAGED_MCP_TOKEN_FILE";
export const MANAGED_MCP_TOKEN_FILE_NAME = "managed-mcp.token";

// Explicit names first; the suffix rule catches future Statewright credential
// carriers without stripping flags such as STATEWRIGHT_NATIVE_TOKEN_TELEMETRY.
export const STATEWRIGHT_CREDENTIAL_ENV = Object.freeze([
  "STATEWRIGHT_API_KEY",
  "STATEWRIGHT_TELEMETRY_API_KEY",
  "STATEWRIGHT_MANAGED_MCP_TOKEN",
  MANAGED_MCP_TOKEN_FILE_ENV,
  "STATEWRIGHT_ADAPTER_TOKEN",
  "STATEWRIGHT_DESKTOP_MCP_TOKEN",
  "STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN",
  "STATEWRIGHT_DELIVERY_EXECUTION_TOKEN",
  "STATEWRIGHT_USAGE_CONTROL_TOKEN",
  "STATEWRIGHT_REFRESH_TOKEN",
]);
const CREDENTIAL_SUFFIX = /^STATEWRIGHT_[A-Z0-9_]*(?:_API_KEY|_TOKEN|_TOKEN_FILE|_SECRET|_PASSWORD)$/i;

export function isStatewrightCredentialEnvName(name) {
  return STATEWRIGHT_CREDENTIAL_ENV.includes(name) || CREDENTIAL_SUFFIX.test(name) || /REFRESH_TOKEN/i.test(name) && /^STATEWRIGHT_/i.test(name);
}

export function stripStatewrightCredentials(environment = {}, { keep = [] } = {}) {
  const stripped = {};
  for (const [name, value] of Object.entries(environment)) {
    if (keep.includes(name) || !isStatewrightCredentialEnvName(name)) stripped[name] = value;
  }
  return stripped;
}

// Patterns for Codex's shell_environment_policy.exclude. Codex applies these
// to the shell/exec commands it spawns (not to MCP servers or hooks), as
// defense in depth if a credential ever reaches the Codex environment again.
export const CODEX_SHELL_CREDENTIAL_EXCLUDES = Object.freeze([
  "STATEWRIGHT_*API_KEY*",
  "STATEWRIGHT_*_TOKEN",
  "STATEWRIGHT_*_TOKEN_FILE",
  "STATEWRIGHT_*SECRET*",
  "STATEWRIGHT_*PASSWORD*",
  "STATEWRIGHT_*REFRESH*",
]);

function tomlString(value) {
  return JSON.stringify(String(value));
}

function unquoteTomlString(raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

// A `-c shell_environment_policy.exclude=[...]` override replaces the array a
// user configured. Read their top-level config array (best effort, string
// literals only) so the managed override is a union, never a weakening.
export function configuredShellExcludes(configSource = "") {
  if (typeof configSource !== "string" || !configSource) return [];
  const lines = configSource.split(/\r?\n/);
  let inPolicy = false;
  let collecting = null;
  for (const line of lines) {
    const trimmed = line.replace(/\s+#.*$/, "").trim();
    if (collecting !== null) {
      collecting += ` ${trimmed}`;
      if (trimmed.includes("]")) break;
      continue;
    }
    const table = trimmed.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (table) { inPolicy = table[1] === "shell_environment_policy"; continue; }
    const dotted = trimmed.match(/^shell_environment_policy\.exclude\s*=\s*(.*)$/);
    const local = inPolicy ? trimmed.match(/^exclude\s*=\s*(.*)$/) : null;
    const match = dotted ?? local;
    if (!match) continue;
    collecting = match[1];
    if (collecting.includes("]")) break;
  }
  if (collecting === null) return [];
  const body = collecting.slice(collecting.indexOf("[") + 1, collecting.lastIndexOf("]"));
  const values = [];
  for (const item of body.match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) ?? []) {
    const value = unquoteTomlString(item);
    if (typeof value === "string" && value) values.push(value);
  }
  return values;
}

export async function codexShellEnvironmentPolicyArgs({ codexHome } = {}) {
  let configured = [];
  if (codexHome) {
    try { configured = configuredShellExcludes(await readFile(join(codexHome, "config.toml"), "utf8")); }
    catch { configured = []; }
  }
  const excludes = [...new Set([...configured, ...CODEX_SHELL_CREDENTIAL_EXCLUDES])];
  return ["-c", `shell_environment_policy.exclude=[${excludes.map(tomlString).join(",")}]`];
}

// Writes the bridge token where only the owning user can read it. The path is
// the only thing the Codex environment carries; the value never enters env or
// argv. Returns the path; callers remove it with removeManagedMcpTokenFile.
export async function writeManagedMcpTokenFile(directory, token) {
  if (typeof token !== "string" || !token) throw new Error("Managed MCP bridge token is unavailable.");
  const path = join(directory, MANAGED_MCP_TOKEN_FILE_NAME);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}

export async function removeManagedMcpTokenFile(path, token = null) {
  if (!path) return;
  try {
    if (token !== null && await readFile(path, "utf8") !== token) return;
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// The environment a managed Codex process (TUI, App Server, `codex exec`) may
// see. Credentials are stripped; the bridge is addressed by URL plus the path
// of its 0600 token file.
export function managedCodexEnvironment(environment, { mcpUrl = null, tokenFile = null, extra = {} } = {}) {
  const isolated = stripStatewrightCredentials({ ...environment, ...extra });
  if (mcpUrl) isolated.STATEWRIGHT_MANAGED_MCP_URL = mcpUrl;
  if (tokenFile) isolated[MANAGED_MCP_TOKEN_FILE_ENV] = tokenFile;
  return isolated;
}

// Reads a credential handed over on stdin by the owning supervisor. The pipe
// is closed after one JSON document, so nothing else can read it later.
export async function readCredentialHandoff(stream) {
  if (!stream || stream.isTTY) return null;
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null;
  } catch {
    return null;
  }
}
