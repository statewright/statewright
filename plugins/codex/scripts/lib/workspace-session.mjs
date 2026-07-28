import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSafeDeliveryRunId } from "./delivery-config.mjs";

const execFileAsync = promisify(execFile);
const MANIFEST_VERSION = 1;

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: options.env ?? process.env,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function git(cwd, args) {
  return run("git", args, { cwd });
}

function nowIso() {
  return new Date().toISOString();
}

function defaultRunId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `sw-${stamp}-${randomUUID().slice(0, 8)}`;
}

function digestManifest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifest_digest;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
}

async function canonicalRepository(path) {
  const { stdout } = await git(path, ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

async function assertRef(path, ref, description) {
  try {
    const { stdout } = await git(path, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return stdout.trim();
  } catch {
    throw new Error(`${description} '${ref}' does not resolve to a commit in ${path}.`);
  }
}

async function assertBranchName(path, branch, description) {
  try {
    await git(path, ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error(`${description} '${branch}' is not a valid Git branch name.`);
  }
}

function parseWorktrees(output) {
  const entries = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

export class WorkspaceSession {
  constructor(config, manifest) {
    this.config = config;
    this.manifest = manifest;
    this.runRoot = dirname(manifest.manifest_path);
    this.manifestPath = manifest.manifest_path;
    this.primary = manifest.repositories.find((repo) => repo.primary);
    this.primaryCwd = this.primary.worktree_path;
  }

  static async prepare(config, options = {}) {
    const runId = options.runId ?? defaultRunId();
    if (!isSafeDeliveryRunId(runId)) {
      throw new Error("delivery run ID must be a lowercase safe slug.");
    }
    const runRoot = join(config.workspace.root, runId);
    const manifestPath = join(runRoot, "manifest.json");
    const existing = await stat(manifestPath).catch(() => null);
    if (existing) return WorkspaceSession.resume(config, manifestPath);

    await mkdir(config.workspace.root, { recursive: true, mode: 0o700 });
    await mkdir(runRoot, { recursive: false, mode: 0o700 });

    const created = [];
    try {
      for (const configured of config.workspace.repositories) {
        const sourcePath = await canonicalRepository(configured.sourcePath);
        const baseCommit = await assertRef(
          sourcePath,
          configured.baseRef,
          `base ref for ${configured.name}`,
        );
        const targetHead = await assertRef(
          sourcePath,
          configured.targetBranch,
          `target branch for ${configured.name}`,
        );
        await assertBranchName(
          sourcePath,
          configured.targetBranch,
          `target branch for ${configured.name}`,
        );
        const branch = `statewright/run-${runId}-${configured.name}`;
        await assertBranchName(sourcePath, branch, `run branch for ${configured.name}`);
        const worktreePath = join(runRoot, configured.name);
        await git(sourcePath, [
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          baseCommit,
        ]);
        created.push({ name: configured.name, sourcePath, worktreePath, branch });
      }

      const repositories = await Promise.all(
        config.workspace.repositories.map(async (configured) => {
          const item = created.find((candidate) => candidate.name === configured.name);
          const sourcePath = await canonicalRepository(configured.sourcePath);
          return {
            name: configured.name,
            source_path: sourcePath,
            worktree_path: item.worktreePath,
            branch: item.branch,
            base_ref: configured.baseRef,
            base_commit: await assertRef(sourcePath, configured.baseRef, "base ref"),
            target_branch: configured.targetBranch,
            target_head: await assertRef(sourcePath, configured.targetBranch, "target branch"),
            primary: configured.primary,
            promoted_commit: null,
          };
        }),
      );
      const manifest = {
        version: MANIFEST_VERSION,
        run_id: runId,
        created_at: nowIso(),
        config_path: config.configPath,
        manifest_path: manifestPath,
        evidence_path: join(config.preview.evidenceRoot, runId),
        status: "prepared",
        repositories,
        promotion: {
          mode: config.promotion.mode,
          status: "pending",
          completed_at: null,
        },
        manifest_digest: null,
      };
      manifest.manifest_digest = digestManifest(manifest);
      await mkdir(manifest.evidence_path, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(manifestPath, manifest);
      return new WorkspaceSession(config, manifest);
    } catch (error) {
      for (const item of created.reverse()) {
        await git(item.sourcePath, ["worktree", "remove", "--force", item.worktreePath]).catch(
          () => {},
        );
        await git(item.sourcePath, ["branch", "-D", item.branch]).catch(() => {});
      }
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
  }

  static async resume(config, manifestPath) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`unsupported delivery manifest version: ${manifest.version}`);
    }
    if (manifest.manifest_digest !== digestManifest(manifest)) {
      throw new Error(`delivery manifest digest mismatch: ${manifestPath}`);
    }
    if (manifest.config_path !== config.configPath) {
      throw new Error("delivery manifest was created from a different config path.");
    }
    const configuredNames = config.workspace.repositories.map((repo) => repo.name).sort();
    const manifestNames = (manifest.repositories ?? []).map((repo) => repo.name).sort();
    if (JSON.stringify(configuredNames) !== JSON.stringify(manifestNames)) {
      throw new Error("delivery manifest repository set does not match the current config.");
    }
    for (const repo of manifest.repositories ?? []) {
      const top = await canonicalRepository(repo.worktree_path).catch(() => null);
      if (top !== repo.worktree_path) {
        throw new Error(`delivery worktree is unavailable: ${repo.worktree_path}`);
      }
      const { stdout } = await git(repo.worktree_path, ["branch", "--show-current"]);
      if (stdout.trim() !== repo.branch) {
        throw new Error(`delivery worktree branch mismatch for ${repo.name}.`);
      }
    }
    return new WorkspaceSession(config, manifest);
  }

  async saveManifest() {
    this.manifest.manifest_digest = digestManifest(this.manifest);
    await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  driverPath() {
    if (resolve(this.config.preview.driver) === this.config.preview.driver) {
      return this.config.preview.driver;
    }
    return resolve(this.primaryCwd, this.config.preview.driver);
  }

  async verifyCleanSourceWorktrees() {
    for (const repo of this.manifest.repositories) {
      const { stdout } = await git(repo.worktree_path, ["status", "--porcelain"]);
      if (stdout.trim()) {
        throw new Error(`run worktree '${repo.name}' must be clean before promotion.`);
      }
    }
  }

  async fingerprint() {
    await this.verifyCleanSourceWorktrees();
    const heads = [];
    for (const repo of this.manifest.repositories) {
      const { stdout } = await git(repo.worktree_path, ["rev-parse", "HEAD"]);
      heads.push([repo.name, stdout.trim()]);
    }
    return createHash("sha256")
      .update(JSON.stringify(heads))
      .digest("hex")
      .slice(0, 16);
  }

  async preflightPromotion() {
    await this.verifyCleanSourceWorktrees();
    const plans = [];
    for (const repo of this.manifest.repositories) {
      const currentTarget = await assertRef(
        repo.source_path,
        repo.target_branch,
        `target branch for ${repo.name}`,
      );
      if (currentTarget !== repo.target_head) {
        throw new Error(
          `target branch '${repo.target_branch}' moved for ${repo.name}: `
          + `expected ${repo.target_head}, found ${currentTarget}.`,
        );
      }
      const { stdout } = await git(repo.source_path, ["worktree", "list", "--porcelain"]);
      const targetWorktree = parseWorktrees(stdout).find(
        (entry) => entry.branch === repo.target_branch,
      );
      if (targetWorktree) {
        const status = await git(targetWorktree.path, ["status", "--porcelain"]);
        if (status.stdout.trim()) {
          throw new Error(
            `target branch '${repo.target_branch}' is checked out in a dirty worktree: `
            + targetWorktree.path,
          );
        }
      }
      plans.push({ repo, targetWorktree });
    }
    return plans;
  }

  async promote() {
    if (this.config.promotion.mode === "manual") {
      throw new Error("delivery config requires manual promotion.");
    }
    if (this.manifest.promotion.status === "complete") return this.manifest.promotion;

    const plans = await this.preflightPromotion();
    const prepared = [];
    try {
      for (const { repo, targetWorktree } of plans) {
        const promotionBranch = `statewright/promote-${this.manifest.run_id}-${repo.name}`;
        await assertBranchName(repo.source_path, promotionBranch, "promotion branch");
        const promotionPath = join(this.runRoot, "promotion", repo.name);
        await mkdir(dirname(promotionPath), { recursive: true, mode: 0o700 });
        await git(repo.source_path, [
          "worktree",
          "add",
          "-b",
          promotionBranch,
          promotionPath,
          repo.target_head,
        ]);
        const item = {
          repo,
          targetWorktree,
          promotionBranch,
          promotionPath,
          promotedCommit: null,
          keepPromotionWorktree: false,
        };
        prepared.push(item);
        await git(promotionPath, ["merge", "--squash", repo.branch]);
        const staged = await git(promotionPath, ["diff", "--cached", "--quiet"]).then(
          () => false,
          () => true,
        );
        if (staged) {
          await git(promotionPath, [
            "commit",
            "-m",
            `${this.config.promotion.commitMessage} (${this.manifest.run_id}/${repo.name})`,
          ]);
        }
        item.promotedCommit = (
          await git(promotionPath, ["rev-parse", "HEAD"])
        ).stdout.trim();
      }

      for (const item of prepared) {
        if (item.targetWorktree) {
          await git(item.targetWorktree.path, ["merge", "--ff-only", item.promotionBranch]);
        } else {
          await git(item.repo.source_path, [
            "update-ref",
            `refs/heads/${item.repo.target_branch}`,
            item.promotedCommit,
            item.repo.target_head,
          ]);
          await git(item.repo.source_path, ["worktree", "remove", item.promotionPath]);
          await git(item.repo.source_path, ["branch", "-D", item.promotionBranch]);
          await git(item.repo.source_path, [
            "worktree",
            "add",
            "--detach",
            item.promotionPath,
            item.promotedCommit,
          ]);
          item.promotionBranch = null;
          item.keepPromotionWorktree = true;
        }
        item.repo.promoted_commit = item.promotedCommit;
        item.repo.promotion_branch = item.promotionBranch;
        item.repo.promoted_worktree_path =
          item.targetWorktree?.path ?? item.promotionPath;
      }
      this.manifest.promotion.status = "complete";
      this.manifest.promotion.completed_at = nowIso();
      await this.saveManifest();
      return this.manifest.promotion;
    } finally {
      for (const item of prepared) {
        if (item.keepPromotionWorktree) continue;
        await git(item.repo.source_path, ["worktree", "remove", item.promotionPath]).catch(
          () => {},
        );
        if (item.promotionBranch) {
          await git(item.repo.source_path, ["branch", "-D", item.promotionBranch]).catch(
            () => {},
          );
        }
      }
    }
  }

  async cleanup() {
    if (this.manifest.promotion.status !== "complete") {
      throw new Error("refusing worktree cleanup before promotion is complete.");
    }
    for (const repo of [...this.manifest.repositories].reverse()) {
      await git(repo.source_path, ["worktree", "remove", repo.worktree_path]);
      await git(repo.source_path, ["branch", "-D", repo.branch]);
      if (
        repo.promoted_worktree_path
        && repo.promoted_worktree_path.startsWith(`${this.runRoot}/`)
      ) {
        await git(repo.source_path, ["worktree", "remove", repo.promoted_worktree_path]);
        if (repo.promotion_branch) {
          await git(repo.source_path, ["branch", "-D", repo.promotion_branch]);
        }
      }
    }
    this.manifest.status = "cleaned";
    this.manifest.cleaned_at = nowIso();
    await this.saveManifest();
  }
}

export { digestManifest, parseWorktrees };
