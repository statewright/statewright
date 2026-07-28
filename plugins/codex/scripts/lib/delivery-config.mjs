import { stat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

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

function validateRelativeDriver(value) {
  const driver = requireString(value, "preview.driver");
  if (isAbsolute(driver)) return driver;
  if (driver.split(/[\\/]/).includes("..")) {
    throw new Error("preview.driver must not contain '..'.");
  }
  return driver;
}

export function validateDeliveryConfig(raw, configPath) {
  const config = requireObject(raw, "delivery config");
  if (config.version !== 1) {
    throw new Error("delivery config version must be 1.");
  }
  const configDir = dirname(configPath);
  const workspace = requireObject(config.workspace, "workspace");
  if (workspace.mode !== "git_worktree") {
    throw new Error("workspace.mode must be 'git_worktree'.");
  }
  const root = resolveConfiguredPath(configDir, workspace.root, "workspace.root");
  if (!Array.isArray(workspace.repositories) || workspace.repositories.length === 0) {
    throw new Error("workspace.repositories must contain at least one repository.");
  }

  const names = new Set();
  let primaryCount = 0;
  const repositories = workspace.repositories.map((entry, index) => {
    const repo = requireObject(entry, `workspace.repositories[${index}]`);
    const name = requireString(repo.name, `workspace.repositories[${index}].name`);
    if (!SAFE_NAME.test(name)) {
      throw new Error(`repository name '${name}' must be a lowercase safe slug.`);
    }
    if (names.has(name)) throw new Error(`duplicate repository name '${name}'.`);
    names.add(name);
    if (repo.primary === true) primaryCount += 1;
    return {
      name,
      sourcePath: resolveConfiguredPath(
        configDir,
        repo.path,
        `workspace.repositories[${index}].path`,
      ),
      baseRef: requireString(repo.base_ref, `workspace.repositories[${index}].base_ref`),
      targetBranch: requireString(
        repo.target_branch,
        `workspace.repositories[${index}].target_branch`,
      ),
      primary: repo.primary === true,
    };
  });
  if (primaryCount !== 1) {
    throw new Error("workspace.repositories must declare exactly one primary repository.");
  }

  const preview = requireObject(config.preview, "preview");
  const driver = validateRelativeDriver(preview.driver);
  const evidenceRoot = preview.evidence_root
    ? resolveConfiguredPath(configDir, preview.evidence_root, "preview.evidence_root")
    : resolve(root, ".evidence");
  const actionTimeoutMs = preview.action_timeout_ms ?? 1_800_000;
  if (
    !Number.isSafeInteger(actionTimeoutMs)
    || actionTimeoutMs < 1_000
    || actionTimeoutMs > 7_200_000
  ) {
    throw new Error("preview.action_timeout_ms must be an integer from 1000 to 7200000.");
  }

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
    configPath,
    configDir,
    workspace: { mode: "git_worktree", root, repositories },
    preview: { driver, evidenceRoot, actionTimeoutMs },
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

export async function assertDeliveryConfigPaths(config) {
  for (const repo of config.workspace.repositories) {
    const info = await stat(repo.sourcePath).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`repository '${repo.name}' path does not exist: ${repo.sourcePath}`);
    }
  }
  if (isAbsolute(config.preview.driver)) {
    const info = await stat(config.preview.driver).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`preview driver does not exist: ${config.preview.driver}`);
    }
  }
}

export function isSafeDeliveryRunId(value) {
  return typeof value === "string" && SAFE_NAME.test(value);
}
