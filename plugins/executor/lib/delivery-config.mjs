import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const DELIVERY_CONFIG_RELATIVE_PATH = join(".statewright", "delivery.json");
export const DELIVERY_DOCS_PATH = "plugins/codex/docs/isolated-delivery.md";
export const DELIVERY_ACTIONS = [
  "prepare",
  "deploy",
  "validate",
  "lock",
  "renew",
  "preflight-promote",
  "promote",
  "unlock",
  "teardown",
  "discard",
];
const DEFAULT_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function resolveConfiguredPath(configDir, value, field) {
  const input = requireString(value, field);
  return resolve(configDir, input);
}

function validateRelativePath(value, field, rootField) {
  const path = requireString(value, field);
  if (isAbsolute(path)) {
    throw new Error(`${field} must be relative to ${rootField}.`);
  }
  if (path.split(/[\\/]/).includes("..")) {
    throw new Error(`${field} must not contain '..'.`);
  }
  return path;
}

function validateEnvironmentAllowlist(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("hooks.environment_allowlist must contain at least PATH.");
  }
  const names = new Set();
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid hook environment variable name '${name}'.`);
    }
    names.add(name);
  }
  if (!names.has("PATH")) {
    throw new Error("hooks.environment_allowlist must include PATH.");
  }
  return [...names];
}

function validateActions(value) {
  const overrides = value === undefined ? {} : requireObject(value, "hooks.actions");
  for (const action of Object.keys(overrides)) {
    if (!DELIVERY_ACTIONS.includes(action)) {
      throw new Error(`hooks.actions contains unsupported action '${action}'.`);
    }
  }
  return Object.fromEntries(DELIVERY_ACTIONS.map((action) => {
    const task = overrides[action] ?? `delivery:${action}`;
    if (typeof task !== "string" || !SAFE_TASK_NAME.test(task)) {
      throw new Error(`hooks.actions.${action} must be a safe Taskfile task name.`);
    }
    return [action, task];
  }));
}

export function validateDeliveryConfig(raw, configPath) {
  const config = requireObject(raw, "delivery config");
  if ((config.version ?? 1) !== 1) {
    throw new Error("delivery config version must be 1.");
  }
  const enabled = Object.hasOwn(config, "enabled") ? config.enabled : true;
  if (typeof enabled !== "boolean") {
    throw new Error("delivery config enabled must be true or false.");
  }
  const configDir = dirname(configPath);
  if (!enabled) {
    return {
      version: 1,
      enabled: false,
      configPath,
      configDir,
      docsPath: DELIVERY_DOCS_PATH,
    };
  }

  const workspace = requireObject(config.workspace, "workspace");
  if ((workspace.mode ?? "git_worktree") !== "git_worktree") {
    throw new Error("workspace.mode must be 'git_worktree'.");
  }
  const workspaceRoot = workspace.root
    ? resolveConfiguredPath(configDir, workspace.root, "workspace.root")
    : join(homedir(), ".statewright", "delivery-runs");
  if (!Array.isArray(workspace.repositories) || workspace.repositories.length === 0) {
    throw new Error("workspace.repositories must contain at least one repository.");
  }

  const names = new Set();
  const declaredPrimaryCount = workspace.repositories.filter(
    (entry) => entry?.primary === true,
  ).length;
  if (declaredPrimaryCount > 1) {
    throw new Error("workspace.repositories must declare at most one primary repository.");
  }
  const repositories = workspace.repositories.map((entry, index) => {
    const repo = requireObject(entry, `workspace.repositories[${index}]`);
    const name = requireString(repo.name, `workspace.repositories[${index}].name`);
    if (!SAFE_NAME.test(name)) {
      throw new Error(`repository name '${name}' must be a lowercase safe slug.`);
    }
    if (names.has(name)) throw new Error(`duplicate repository name '${name}'.`);
    names.add(name);
    const targetBranch = requireString(
      repo.target_branch,
      `workspace.repositories[${index}].target_branch`,
    );
    return {
      name,
      sourcePath: resolveConfiguredPath(
        configDir,
        repo.path,
        `workspace.repositories[${index}].path`,
      ),
      baseRef: requireString(
        repo.base_ref ?? targetBranch,
        `workspace.repositories[${index}].base_ref`,
      ),
      targetBranch,
      primary: declaredPrimaryCount === 0 ? index === 0 : repo.primary === true,
    };
  });

  const hooks = requireObject(config.hooks, "hooks");
  const hookRoot = resolveConfiguredPath(
    configDir,
    hooks.root ?? "delivery-hooks",
    "hooks.root",
  );
  const taskfile = validateRelativePath(
    hooks.taskfile ?? "Taskfile.yml",
    "hooks.taskfile",
    "hooks.root",
  );
  const bundleSha256 = requireString(hooks.bundle_sha256, "hooks.bundle_sha256");
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw new Error("hooks.bundle_sha256 must be a lowercase SHA-256 digest.");
  }
  const environmentAllowlist = validateEnvironmentAllowlist(
    hooks.environment_allowlist ?? DEFAULT_ENVIRONMENT_ALLOWLIST,
  );
  const actions = validateActions(hooks.actions);
  const actionTimeoutMs = hooks.action_timeout_ms ?? 1_800_000;
  if (
    !Number.isSafeInteger(actionTimeoutMs)
    || actionTimeoutMs < 1_000
    || actionTimeoutMs > 7_200_000
  ) {
    throw new Error("hooks.action_timeout_ms must be an integer from 1000 to 7200000.");
  }

  const preview = requireObject(config.preview ?? {}, "preview");
  const evidenceRoot = preview.evidence_root
    ? resolveConfiguredPath(configDir, preview.evidence_root, "preview.evidence_root")
    : resolve(workspaceRoot, ".evidence");

  const promotion = requireObject(config.promotion ?? { mode: "manual" }, "promotion");
  if (!["manual", "squash"].includes(promotion.mode)) {
    throw new Error("promotion.mode must be 'manual' or 'squash'.");
  }
  const commitMessage =
    promotion.commit_message ?? "feat: promote Statewright delivery run";
  requireString(commitMessage, "promotion.commit_message");
  if (/[\u0000\r\n]/.test(commitMessage)) {
    throw new Error("promotion.commit_message must be a single printable line.");
  }

  return {
    version: 1,
    enabled: true,
    configPath,
    configDir,
    docsPath: DELIVERY_DOCS_PATH,
    workspace: { mode: "git_worktree", root: workspaceRoot, repositories },
    hooks: {
      root: hookRoot,
      taskfile,
      bundleSha256,
      actions,
      environmentAllowlist,
      actionTimeoutMs,
    },
    preview: { evidenceRoot },
    promotion: { mode: promotion.mode, commitMessage },
  };
}

export async function loadDeliveryConfig(path, cwd = process.cwd()) {
  const configPath = resolve(cwd, path);
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read delivery config '${configPath}': ${error.message}`);
  }
  return validateDeliveryConfig(raw, configPath);
}

export async function findDeliveryConfig(cwd = process.cwd()) {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, DELIVERY_CONFIG_RELATIVE_PATH);
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function resolveDeliveryBootstrap({
  cwd = process.cwd(),
  explicitPath = null,
} = {}) {
  const configPath = explicitPath
    ? resolve(cwd, explicitPath)
    : await findDeliveryConfig(cwd);
  if (!configPath) {
    return {
      enabled: false,
      source: "dormant",
      config: null,
      expectedConfigPath: resolve(cwd, DELIVERY_CONFIG_RELATIVE_PATH),
      docsPath: DELIVERY_DOCS_PATH,
    };
  }
  const config = await loadDeliveryConfig(configPath);
  return {
    enabled: config.enabled,
    source: explicitPath ? "explicit" : "project",
    config,
    expectedConfigPath: configPath,
    docsPath: DELIVERY_DOCS_PATH,
  };
}

export async function assertDeliveryConfigPaths(config) {
  if (!config.enabled) return;
  for (const repo of config.workspace.repositories) {
    const info = await stat(repo.sourcePath).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`repository '${repo.name}' path does not exist: ${repo.sourcePath}`);
    }
  }
  const rootInfo = await stat(config.hooks.root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new Error(`delivery hook root does not exist: ${config.hooks.root}`);
  }
  const taskfilePath = resolve(config.hooks.root, config.hooks.taskfile);
  if (!taskfilePath.startsWith(`${config.hooks.root}/`)) {
    throw new Error("delivery taskfile escapes hooks.root.");
  }
  const taskfileInfo = await stat(taskfilePath).catch(() => null);
  if (!taskfileInfo?.isFile()) {
    throw new Error(`delivery taskfile does not exist: ${taskfilePath}`);
  }
}

export function isSafeDeliveryRunId(value) {
  return typeof value === "string" && SAFE_NAME.test(value);
}
