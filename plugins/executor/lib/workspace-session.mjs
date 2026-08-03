import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isSafeDeliveryRunId } from "./delivery-config.mjs";

const execFileAsync = promisify(execFile);
const MANIFEST_VERSION = 1;
const TASKFILE_ADAPTER_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "taskfile-delivery-adapter.mjs",
);
const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
  const env = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    { cwd, env },
  );
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

function digestConfig(config) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: config.version,
      workspace: config.workspace,
      hooks: config.hooks,
      preview: config.preview,
      promotion: config.promotion,
    }))
    .digest("hex");
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

async function bundleFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`delivery hook bundle must not contain symlinks: ${path}`);
    }
    if (info.isDirectory()) files.push(...await bundleFiles(root, path));
    else if (info.isFile()) files.push(path);
    else throw new Error(`unsupported delivery hook bundle entry: ${path}`);
  }
  return files;
}

export async function digestHookBundle(root) {
  const hash = createHash("sha256");
  for (const path of await bundleFiles(root)) {
    const name = relative(root, path).split("\\").join("/");
    const content = await readFile(path);
    hash.update(`${name.length}:${name}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function snapshotHookBundle(config, runRoot) {
  const sourceInfo = await lstat(config.hooks.root);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("delivery hook root must be a real directory.");
  }
  const sourceDigest = await digestHookBundle(config.hooks.root);
  if (sourceDigest !== config.hooks.bundleSha256) {
    throw new Error(
      `delivery hook bundle digest mismatch: expected ${config.hooks.bundleSha256}, `
      + `found ${sourceDigest}.`,
    );
  }
  const snapshotPath = join(runRoot, "trusted-hooks");
  await cp(config.hooks.root, snapshotPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const snapshotDigest = await digestHookBundle(snapshotPath);
  if (snapshotDigest !== sourceDigest) {
    throw new Error("delivery hook bundle changed while it was being snapshotted.");
  }
  return { path: snapshotPath, digest: snapshotDigest };
}

async function snapshotTaskfileAdapter(runRoot) {
  const sourceInfo = await lstat(TASKFILE_ADAPTER_SOURCE);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("built-in Taskfile delivery adapter must be a regular file.");
  }
  const content = await readFile(TASKFILE_ADAPTER_SOURCE);
  const digest = createHash("sha256").update(content).digest("hex");
  const root = join(runRoot, "trusted-adapter");
  const path = join(root, "taskfile-delivery-adapter.mjs");
  await mkdir(root, { recursive: false, mode: 0o700 });
  await writeFile(path, content, { mode: 0o500 });
  const snapshot = await readFile(path);
  const snapshotDigest = createHash("sha256").update(snapshot).digest("hex");
  if (snapshotDigest !== digest) {
    throw new Error("Taskfile delivery adapter changed while it was being snapshotted.");
  }
  return { path, digest };
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
    if (existing) return WorkspaceSession.resume(config, manifestPath, options);

    await mkdir(config.workspace.root, { recursive: true, mode: 0o700 });
    await mkdir(runRoot, { recursive: false, mode: 0o700 });

    const created = [];
    try {
      const hookBundle = await snapshotHookBundle(config, runRoot);
      const adapter = await snapshotTaskfileAdapter(runRoot);
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
        ownership_token: randomUUID(),
        created_at: nowIso(),
        config_path: config.configPath,
        config_digest: digestConfig(config),
        manifest_path: manifestPath,
        evidence_path: join(config.preview.evidenceRoot, runId),
        hook_bundle_path: hookBundle.path,
        hook_bundle_sha256: hookBundle.digest,
        adapter_path: adapter.path,
        adapter_sha256: adapter.digest,
        status: "prepared",
        repositories,
        promotion: {
          mode: config.promotion.mode,
          status: "pending",
          completed_at: null,
          journal: [],
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

  static async resume(config, manifestPath, options = {}) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`unsupported delivery manifest version: ${manifest.version}`);
    }
    if (manifest.manifest_digest !== digestManifest(manifest)) {
      throw new Error(`delivery manifest digest mismatch: ${manifestPath}`);
    }
    if (
      typeof manifest.ownership_token !== "string"
      || !UUID_V4.test(manifest.ownership_token)
    ) {
      throw new Error("delivery manifest ownership token is invalid.");
    }
    if (manifest.config_path !== config.configPath) {
      throw new Error("delivery manifest was created from a different config path.");
    }
    if (manifest.config_digest !== digestConfig(config)) {
      throw new Error("delivery manifest was created from different config contents.");
    }
    if (manifest.hook_bundle_sha256 !== config.hooks.bundleSha256) {
      throw new Error("delivery manifest hook digest does not match the current config.");
    }
    const hookDigest = await digestHookBundle(manifest.hook_bundle_path);
    if (hookDigest !== manifest.hook_bundle_sha256) {
      throw new Error("snapshotted delivery hook bundle digest mismatch.");
    }
    const adapterContent = await readFile(manifest.adapter_path);
    const adapterDigest = createHash("sha256").update(adapterContent).digest("hex");
    if (adapterDigest !== manifest.adapter_sha256) {
      throw new Error("snapshotted Taskfile delivery adapter digest mismatch.");
    }
    const configuredNames = config.workspace.repositories.map((repo) => repo.name).sort();
    const manifestNames = (manifest.repositories ?? []).map((repo) => repo.name).sort();
    if (JSON.stringify(configuredNames) !== JSON.stringify(manifestNames)) {
      throw new Error("delivery manifest repository set does not match the current config.");
    }
    for (const repo of manifest.repositories ?? []) {
      const top = await canonicalRepository(repo.worktree_path).catch(() => null);
      const expected = await realpath(repo.worktree_path).catch(() => null);
      if (!top || !expected || await realpath(top) !== expected) {
        throw new Error(`delivery worktree is unavailable: ${repo.worktree_path}`);
      }
      const { stdout } = await git(repo.worktree_path, ["branch", "--show-current"]);
      if (stdout.trim() !== repo.branch) {
        throw new Error(`delivery worktree branch mismatch for ${repo.name}.`);
      }
    }
    const session = new WorkspaceSession(config, manifest);
    const interrupted = ["preparing", "applying", "recovery_required"].includes(
      manifest.promotion?.status,
    ) || (manifest.promotion?.journal ?? []).some(
      (entry) =>
        ["preparing", "prepared", "applying", "applied"].includes(entry.status),
    );
    if (interrupted && !options.allowRecovery) {
      throw new Error(
        "delivery promotion was interrupted; run statewright-delivery recover "
        + "with the exact delivery run ID before resuming.",
      );
    }
    return session;
  }

  async saveManifest() {
    this.manifest.manifest_digest = digestManifest(this.manifest);
    await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  adapterPath() {
    const path = resolve(this.manifest.adapter_path);
    if (!path.startsWith(`${resolve(this.runRoot)}/trusted-adapter/`)) {
      throw new Error("snapshotted Taskfile delivery adapter escapes the run root.");
    }
    return path;
  }

  async verifyCleanSourceWorktrees() {
    for (const repo of this.manifest.repositories) {
      const { stdout } = await git(repo.worktree_path, ["status", "--porcelain"]);
      if (stdout.trim()) {
        throw new Error(`run worktree '${repo.name}' must be clean before promotion.`);
      }
    }
  }

  async checkpoint() {
    const commits = {};
    for (const repo of this.manifest.repositories) {
      const { stdout } = await git(repo.worktree_path, ["status", "--porcelain"]);
      if (stdout.trim()) {
        await git(repo.worktree_path, ["add", "-A"]);
        await git(repo.worktree_path, [
          "commit",
          "-m",
          `chore(statewright): checkpoint ${this.manifest.run_id}/${repo.name}`,
        ]);
      }
      commits[repo.name] = (
        await git(repo.worktree_path, ["rev-parse", "HEAD"])
      ).stdout.trim();
    }
    return commits;
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
    const applied = [];
    let keepPrepared = false;
    try {
      for (const { repo, targetWorktree } of plans) {
        const sourceHead = (
          await git(repo.worktree_path, ["rev-parse", "HEAD"])
        ).stdout.trim();
        const promotionBranch = `statewright/promote-${this.manifest.run_id}-${repo.name}`;
        const recoveryRef = `refs/statewright/recovery/${this.manifest.run_id}/${repo.name}`;
        await assertBranchName(repo.source_path, promotionBranch, "promotion branch");
        const promotionPath = join(this.runRoot, "promotion", repo.name);
        const item = {
          repo,
          targetWorktree,
          promotionBranch,
          promotionPath,
          promotedCommit: null,
          sourceHead,
          recoveryRef,
          keepPromotionWorktree: false,
        };
        prepared.push(item);
        this.manifest.promotion.status = "preparing";
        this.manifest.promotion.journal = [
          ...(this.manifest.promotion.journal ?? []).filter(
            (entry) => entry.repository !== repo.name,
          ),
          {
            repository: repo.name,
            target_branch: repo.target_branch,
            previous_commit: repo.target_head,
            promoted_commit: null,
            recovery_ref: recoveryRef,
            promotion_branch: promotionBranch,
            promotion_path: promotionPath,
            status: "preparing",
          },
        ];
        await this.saveManifest();
        await mkdir(dirname(promotionPath), { recursive: true, mode: 0o700 });
        await git(repo.source_path, [
          "worktree",
          "add",
          "-b",
          promotionBranch,
          promotionPath,
          repo.target_head,
        ]);
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
        await git(repo.source_path, [
          "update-ref",
          recoveryRef,
          repo.target_head,
        ]);
        const journal = this.manifest.promotion.journal.find(
          (entry) => entry.repository === repo.name,
        );
        journal.promoted_commit = item.promotedCommit;
        journal.status = "prepared";
        await this.saveManifest();
      }

      for (const item of prepared) {
        const journal = this.manifest.promotion.journal.find(
          (entry) => entry.repository === item.repo.name,
        );
        this.manifest.promotion.status = "applying";
        journal.status = "applying";
        journal.apply_started_at = nowIso();
        await this.saveManifest();
        if (item.targetWorktree) {
          await git(item.targetWorktree.path, ["merge", "--ff-only", item.promotionBranch]);
        } else {
          await git(item.repo.source_path, [
            "update-ref",
            `refs/heads/${item.repo.target_branch}`,
            item.promotedCommit,
            item.repo.target_head,
          ]);
        }
        applied.push(item);
        journal.status = "applied";
        journal.applied_at = nowIso();
        await this.saveManifest();

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
        item.repo.promoted_commit = item.promotedCommit;
        item.repo.promoted_source_commit = item.sourceHead;
        item.repo.promotion_branch = null;
        item.repo.promoted_worktree_path = item.promotionPath;
      }
      this.manifest.promotion.status = "complete";
      this.manifest.promotion.completed_at = nowIso();
      await this.saveManifest();
      for (const item of prepared) {
        await git(item.repo.source_path, ["update-ref", "-d", item.recoveryRef]).catch(
          () => {},
        );
      }
      return this.manifest.promotion;
    } catch (error) {
      const rollbackErrors = [];
      for (const item of [...applied].reverse()) {
        try {
          const current = await assertRef(
            item.repo.source_path,
            item.repo.target_branch,
            `rollback target for ${item.repo.name}`,
          );
          if (current !== item.promotedCommit) {
            throw new Error(
              `cannot roll back '${item.repo.name}': target moved to ${current}.`,
            );
          }
          if (item.targetWorktree) {
            const status = await git(item.targetWorktree.path, ["status", "--porcelain"]);
            if (status.stdout.trim()) {
              throw new Error(
                `cannot roll back dirty target worktree for '${item.repo.name}'.`,
              );
            }
            await git(item.targetWorktree.path, ["reset", "--hard", item.repo.target_head]);
          } else {
            await git(item.repo.source_path, [
              "update-ref",
              `refs/heads/${item.repo.target_branch}`,
              item.repo.target_head,
              item.promotedCommit,
            ]);
          }
          const journal = this.manifest.promotion.journal.find(
            (entry) => entry.repository === item.repo.name,
          );
          journal.status = "rolled_back";
          journal.rolled_back_at = nowIso();
          item.repo.promoted_commit = null;
          item.repo.promoted_source_commit = null;
          item.repo.promotion_branch = null;
          item.repo.promoted_worktree_path = null;
          item.keepPromotionWorktree = false;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        keepPrepared = true;
        this.manifest.promotion.status = "recovery_required";
        this.manifest.promotion.recovery_errors = rollbackErrors.map(
          (rollbackError) => String(rollbackError.message ?? rollbackError),
        );
      } else {
        this.manifest.promotion.status = "pending";
        for (const item of prepared) {
          const journal = this.manifest.promotion.journal.find(
            (entry) => entry.repository === item.repo.name,
          );
          if (journal && journal.status !== "rolled_back") {
            journal.status = "rolled_back";
            journal.rolled_back_at = nowIso();
          }
          await git(item.repo.source_path, ["update-ref", "-d", item.recoveryRef]).catch(
            () => {},
          );
        }
      }
      await this.saveManifest();
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "multi-repository promotion failed and rollback requires operator recovery",
        );
      }
      throw error;
    } finally {
      for (const item of prepared) {
        if (keepPrepared) continue;
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

  async preflightCleanup() {
    if (this.manifest.promotion.status !== "complete") {
      throw new Error("refusing worktree cleanup before promotion is complete.");
    }
    await this.verifyPromotedSourceHeads();
  }

  async cleanup() {
    await this.preflightCleanup();
    await this.removeRunWorktrees();
    this.manifest.status = "cleaned";
    this.manifest.cleaned_at = nowIso();
    await this.saveManifest();
  }

  async preflightDiscard(expectedRunId) {
    if (expectedRunId !== this.manifest.run_id) {
      throw new Error("discard confirmation must exactly match the delivery run ID.");
    }
    if (this.manifest.promotion.status === "complete") {
      throw new Error("promoted delivery runs must use normal cleanup, not discard.");
    }
    if (
      ["preparing", "applying", "recovery_required"].includes(
        this.manifest.promotion.status,
      )
      || (this.manifest.promotion.journal ?? []).some(
        (entry) =>
          ["preparing", "prepared", "applying", "applied"].includes(entry.status),
      )
    ) {
      throw new Error("interrupted promotion must be recovered before discard.");
    }
    for (const repo of this.manifest.repositories) {
      const current = await assertRef(
        repo.source_path,
        repo.target_branch,
        `discard target for ${repo.name}`,
      );
      if (current !== repo.target_head) {
        throw new Error(
          `refusing discard because target branch moved for '${repo.name}'.`,
        );
      }
    }
    await this.verifyCleanSourceWorktrees();
    const realRunRoot = await realpath(this.runRoot);
    for (const repo of this.manifest.repositories) {
      const realWorktree = await realpath(repo.worktree_path);
      if (!realWorktree.startsWith(`${realRunRoot}/`)) {
        throw new Error(`refusing to discard foreign worktree path for '${repo.name}'.`);
      }
      const { stdout } = await git(repo.worktree_path, ["branch", "--show-current"]);
      if (stdout.trim() !== repo.branch) {
        throw new Error(`delivery worktree branch mismatch for '${repo.name}'.`);
      }
    }
  }

  async verifyPromotedSourceHeads() {
    for (const repo of this.manifest.repositories) {
      if (!repo.promoted_source_commit) {
        throw new Error(`repository '${repo.name}' has no promoted source commit.`);
      }
      const current = (
        await git(repo.worktree_path, ["rev-parse", "HEAD"])
      ).stdout.trim();
      if (current !== repo.promoted_source_commit) {
        throw new Error(
          `run worktree '${repo.name}' changed after promotion; refusing cleanup.`,
        );
      }
      const status = await git(repo.worktree_path, ["status", "--porcelain"]);
      if (status.stdout.trim()) {
        throw new Error(
          `run worktree '${repo.name}' is dirty after promotion; refusing cleanup.`,
        );
      }
    }
  }

  async discard(expectedRunId) {
    await this.preflightDiscard(expectedRunId);
    await this.removeRunWorktrees();
    this.manifest.status = "discarded";
    this.manifest.discarded_at = nowIso();
    await this.saveManifest();
  }

  async recoverPromotion(expectedRunId) {
    if (expectedRunId !== this.manifest.run_id) {
      throw new Error("recovery confirmation must exactly match the delivery run ID.");
    }
    if (this.manifest.promotion.status === "complete") {
      throw new Error("completed promotion does not require recovery.");
    }
    const errors = [];
    for (const entry of [...(this.manifest.promotion.journal ?? [])].reverse()) {
      const repo = this.manifest.repositories.find(
        (candidate) => candidate.name === entry.repository,
      );
      if (!repo) {
        errors.push(
          new Error(`recovery journal references unknown repo '${entry.repository}'.`),
        );
        continue;
      }
      try {
        const current = await assertRef(
          repo.source_path,
          repo.target_branch,
          `recovery target for ${repo.name}`,
        );
        if (
          current !== entry.previous_commit
          && (!entry.promoted_commit || current !== entry.promoted_commit)
        ) {
          throw new Error(
            `cannot recover '${repo.name}': target moved to ${current}.`,
          );
        }
        if (entry.promoted_commit && current === entry.promoted_commit) {
          const worktrees = parseWorktrees(
            (await git(repo.source_path, ["worktree", "list", "--porcelain"])).stdout,
          );
          const targetWorktree = worktrees.find(
            (candidate) => candidate.branch === repo.target_branch,
          );
          if (targetWorktree) {
            const status = await git(targetWorktree.path, ["status", "--porcelain"]);
            if (status.stdout.trim()) {
              throw new Error(
                `cannot recover dirty target worktree for '${repo.name}'.`,
              );
            }
            await git(targetWorktree.path, ["reset", "--hard", entry.previous_commit]);
          } else {
            await git(repo.source_path, [
              "update-ref",
              `refs/heads/${repo.target_branch}`,
              entry.previous_commit,
              entry.promoted_commit,
            ]);
          }
        }
        entry.status = "rolled_back";
        entry.rolled_back_at = nowIso();
        repo.promoted_commit = null;
        repo.promoted_source_commit = null;
        repo.promotion_branch = null;
        repo.promoted_worktree_path = null;
        const promotionPath =
          entry.promotion_path ?? join(this.runRoot, "promotion", repo.name);
        if (await stat(promotionPath).catch(() => null)) {
          await git(repo.source_path, ["worktree", "remove", promotionPath]);
        }
        const promotionBranch =
          entry.promotion_branch
          ?? `statewright/promote-${this.manifest.run_id}-${repo.name}`;
        const branchExists = await git(repo.source_path, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${promotionBranch}`,
        ]).then(
          () => true,
          () => false,
        );
        if (branchExists) {
          await git(repo.source_path, ["branch", "-D", promotionBranch]);
        }
        await git(repo.source_path, ["update-ref", "-d", entry.recovery_ref]).catch(
          () => {},
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      this.manifest.promotion.status = "recovery_required";
      this.manifest.promotion.recovery_errors = errors.map(
        (error) => String(error.message ?? error),
      );
      await this.saveManifest();
      throw new AggregateError(
        errors,
        "delivery promotion recovery requires operator action",
      );
    }
    this.manifest.promotion.status = "pending";
    this.manifest.promotion.recovered_at = nowIso();
    this.manifest.promotion.recovery_errors = [];
    await this.saveManifest();
    return this.manifest.promotion;
  }

  async removeRunWorktrees() {
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
  }
}

export { digestConfig, digestManifest, parseWorktrees };
