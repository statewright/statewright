import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  digestDriverBundle,
  WorkspaceSession,
} from "../scripts/lib/workspace-session.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository(root, name) {
  const path = join(root, name);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path));
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "statewright-test@example.invalid");
  await git(path, "config", "user.name", "Statewright Test");
  await writeFile(join(path, "README.md"), `${name}\n`);
  await git(path, "add", "README.md");
  await git(path, "commit", "-m", "initial");
  return path;
}

async function config(root, repositories) {
  const driverRoot = join(root, "driver");
  await mkdir(driverRoot, { recursive: true });
  await writeFile(join(driverRoot, "preview.mjs"), "console.log('{}');\n");
  return {
    configPath: join(root, "delivery.json"),
    workspace: {
      mode: "git_worktree",
      root: join(root, "runs"),
      repositories,
    },
    preview: {
      driver: "preview.mjs",
      driverRoot,
      bundleSha256: await digestDriverBundle(driverRoot),
      environmentAllowlist: ["PATH"],
      evidenceRoot: join(root, "evidence"),
      actionTimeoutMs: 10_000,
    },
    promotion: {
      mode: "squash",
      commitMessage: "feat: promote test",
    },
  };
}

test("workspace preparation isolates multiple repositories from dirty canonical trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-workspace-"));
  const app = await createRepository(root, "app");
  const engine = await createRepository(root, "engine");
  await writeFile(join(app, "dirty.txt"), "unrelated local work\n");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
      {
        name: "engine",
        sourcePath: engine,
        baseRef: "main",
        targetBranch: "main",
        primary: false,
      },
    ]),
    { runId: "test-isolation" },
  );

  assert.equal(session.primary.name, "app");
  assert.equal(session.manifest.repositories.length, 2);
  await assert.rejects(readFile(join(session.primaryCwd, "dirty.txt"), "utf8"), /ENOENT/);
  assert.match((await git(app, "status", "--porcelain")).stdout, /dirty\.txt/);

  await session.discard("test-isolation");
  assert.match((await git(app, "status", "--porcelain")).stdout, /dirty\.txt/);
});

test("driver bundle is pinned and snapshotted before agent work starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-driver-snapshot-"));
  const app = await createRepository(root, "app");
  const deliveryConfig = await config(root, [
    {
      name: "app",
      sourcePath: app,
      baseRef: "main",
      targetBranch: "main",
      primary: true,
    },
  ]);
  const session = await WorkspaceSession.prepare(deliveryConfig, {
    runId: "test-driver-snapshot",
  });

  await writeFile(join(deliveryConfig.preview.driverRoot, "preview.mjs"), "changed\n");
  assert.equal(await readFile(session.driverPath(), "utf8"), "console.log('{}');\n");
  await writeFile(session.driverPath(), "tampered\n");
  await assert.rejects(
    WorkspaceSession.resume(deliveryConfig, session.manifestPath),
    /driver bundle digest mismatch/,
  );
});

test("trusted checkpoint commits dirty run worktrees before preview fingerprinting", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-checkpoint-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    await config(root, [{
      name: "app",
      sourcePath: app,
      baseRef: "main",
      targetBranch: "main",
      primary: true,
    }]),
    { runId: "test-checkpoint" },
  );
  const hooks = join(app, "hooks");
  const hookMarker = join(root, "hook-ran");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\nprintf hook-ran > ${JSON.stringify(hookMarker)}\n`,
  );
  await chmod(join(hooks, "pre-commit"), 0o755);
  await git(app, "config", "core.hooksPath", hooks);
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");

  const commits = await session.checkpoint();

  assert.equal(
    commits.app,
    (await git(session.primaryCwd, "rev-parse", "HEAD")).stdout.trim(),
  );
  assert.equal((await git(session.primaryCwd, "status", "--porcelain")).stdout, "");
  assert.match(
    (await git(session.primaryCwd, "log", "-1", "--pretty=%s")).stdout,
    /checkpoint test-checkpoint\/app/,
  );
  await assert.rejects(readFile(hookMarker, "utf8"), /ENOENT/);
});

test("promotion refuses a dirty checked-out target branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-dirty-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
    ]),
    { runId: "test-dirty-target" },
  );
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");
  await git(session.primaryCwd, "add", "feature.txt");
  await git(session.primaryCwd, "commit", "-m", "feature");
  await writeFile(join(app, "README.md"), "dirty target\n");

  await assert.rejects(session.promote(), /checked out in a dirty worktree/);
  assert.equal(session.manifest.promotion.status, "pending");
});

test("promotion squashes a clean run branch into the expected target", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
    ]),
    { runId: "test-promote" },
  );
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");
  await git(session.primaryCwd, "add", "feature.txt");
  await git(session.primaryCwd, "commit", "-m", "feature");

  await session.promote();

  assert.equal(await readFile(join(app, "feature.txt"), "utf8"), "feature\n");
  assert.equal(session.manifest.promotion.status, "complete");
  assert.equal(
    session.manifest.repositories[0].promoted_source_commit,
    (await git(session.primaryCwd, "rev-parse", "HEAD")).stdout.trim(),
  );
  assert.equal(
    (await git(
      session.manifest.repositories[0].promoted_worktree_path,
      "branch",
      "--show-current",
    )).stdout.trim(),
    "",
  );
  assert.match((await git(app, "log", "-1", "--pretty=%s")).stdout, /promote test/);
  await session.cleanup();
});

test("promotion keeps a detached merged-target snapshot when target is not checked out", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-detached-"));
  const app = await createRepository(root, "app");
  await git(app, "checkout", "--detach");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
    ]),
    { runId: "test-detached-target" },
  );
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");
  await git(session.primaryCwd, "add", "feature.txt");
  await git(session.primaryCwd, "commit", "-m", "feature");

  await session.promote();

  const promoted = session.manifest.repositories[0];
  assert.equal(promoted.promotion_branch, null);
  assert.equal(
    (await git(app, "rev-parse", "main")).stdout.trim(),
    promoted.promoted_commit,
  );
  assert.equal(
    (await git(promoted.promoted_worktree_path, "branch", "--show-current")).stdout.trim(),
    "",
  );
  await session.cleanup();
});

test("explicit discard requires the exact run ID and refuses dirty worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-discard-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
    ]),
    { runId: "test-discard" },
  );

  await assert.rejects(session.discard("wrong-run"), /exactly match/);
  await writeFile(join(session.primaryCwd, "dirty.txt"), "uncommitted\n");
  await assert.rejects(session.discard("test-discard"), /must be clean/);
  await import("node:fs/promises").then(({ rm }) =>
    rm(join(session.primaryCwd, "dirty.txt")),
  );

  await session.discard("test-discard");

  assert.equal(session.manifest.status, "discarded");
  await assert.rejects(readFile(session.primaryCwd, "utf8"), /ENOENT|EISDIR/);
  assert.equal((await git(app, "branch", "--list", session.primary.branch)).stdout.trim(), "");
});

test("cleanup refuses commits made after promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-post-promotion-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
    ]),
    { runId: "test-post-promotion" },
  );
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");
  await git(session.primaryCwd, "add", "feature.txt");
  await git(session.primaryCwd, "commit", "-m", "feature");
  await session.promote();
  await writeFile(join(session.primaryCwd, "late.txt"), "late\n");
  await git(session.primaryCwd, "add", "late.txt");
  await git(session.primaryCwd, "commit", "-m", "late");

  await assert.rejects(session.cleanup(), /changed after promotion/);
});

test("multi-repository promotion rolls back earlier targets when a later ref update fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-rollback-"));
  const app = await createRepository(root, "app");
  const engine = await createRepository(root, "engine");
  const originalAppHead = (await git(app, "rev-parse", "main")).stdout.trim();
  const session = await WorkspaceSession.prepare(
    await config(root, [
      {
        name: "app",
        sourcePath: app,
        baseRef: "main",
        targetBranch: "main",
        primary: true,
      },
      {
        name: "engine",
        sourcePath: engine,
        baseRef: "main",
        targetBranch: "main",
        primary: false,
      },
    ]),
    { runId: "test-rollback" },
  );
  for (const repo of session.manifest.repositories) {
    await writeFile(join(repo.worktree_path, "feature.txt"), `${repo.name}\n`);
    await git(repo.worktree_path, "add", "feature.txt");
    await git(repo.worktree_path, "commit", "-m", `feature ${repo.name}`);
  }
  await chmod(engine, 0o555);
  try {
    await assert.rejects(session.promote(), /failed|permission denied/i);
  } finally {
    await chmod(engine, 0o755);
  }

  assert.equal((await git(app, "rev-parse", "main")).stdout.trim(), originalAppHead);
  assert.equal(session.manifest.promotion.status, "pending");
  assert.equal(
    session.manifest.promotion.journal.find((entry) => entry.repository === "app")
      .status,
    "rolled_back",
  );
});

test("interrupted promotion requires explicit recovery before resume or discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-recovery-"));
  const app = await createRepository(root, "app");
  const deliveryConfig = await config(root, [{
    name: "app",
    sourcePath: app,
    baseRef: "main",
    targetBranch: "main",
    primary: true,
  }]);
  const session = await WorkspaceSession.prepare(deliveryConfig, {
    runId: "test-recovery",
  });
  const previous = session.manifest.repositories[0].target_head;
  await writeFile(join(session.primaryCwd, "feature.txt"), "feature\n");
  const commits = await session.checkpoint();
  const promoted = commits.app;
  const recoveryRef = "refs/statewright/recovery/test-recovery/app";
  await git(app, "update-ref", recoveryRef, previous);
  session.manifest.promotion.status = "applying";
  session.manifest.promotion.journal = [{
    repository: "app",
    target_branch: "main",
    previous_commit: previous,
    promoted_commit: promoted,
    recovery_ref: recoveryRef,
    status: "applying",
  }];
  await session.saveManifest();
  await git(app, "merge", "--ff-only", session.manifest.repositories[0].branch);

  await assert.rejects(
    WorkspaceSession.resume(deliveryConfig, session.manifestPath),
    /promotion was interrupted/,
  );
  await assert.rejects(session.preflightDiscard("test-recovery"), /must be recovered/);

  const recovery = await WorkspaceSession.resume(
    deliveryConfig,
    session.manifestPath,
    { allowRecovery: true },
  );
  await recovery.recoverPromotion("test-recovery");

  assert.equal((await git(app, "rev-parse", "main")).stdout.trim(), previous);
  assert.equal(recovery.manifest.promotion.status, "pending");
  assert.equal(recovery.manifest.promotion.journal[0].status, "rolled_back");
  await recovery.discard("test-recovery");
});

test("promotion preparation is journaled before external Git artifacts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-prepare-recovery-"));
  const app = await createRepository(root, "app");
  const deliveryConfig = await config(root, [{
    name: "app",
    sourcePath: app,
    baseRef: "main",
    targetBranch: "main",
    primary: true,
  }]);
  const session = await WorkspaceSession.prepare(deliveryConfig, {
    runId: "test-prepare-recovery",
  });
  const repo = session.manifest.repositories[0];
  const promotionBranch = "statewright/promote-test-prepare-recovery-app";
  const promotionPath = join(session.runRoot, "promotion", "app");
  const recoveryRef =
    "refs/statewright/recovery/test-prepare-recovery/app";
  session.manifest.promotion.status = "preparing";
  session.manifest.promotion.journal = [{
    repository: "app",
    target_branch: "main",
    previous_commit: repo.target_head,
    promoted_commit: null,
    recovery_ref: recoveryRef,
    promotion_branch: promotionBranch,
    promotion_path: promotionPath,
    status: "preparing",
  }];
  await session.saveManifest();
  await mkdir(join(session.runRoot, "promotion"), { recursive: true });
  await git(
    app,
    "worktree",
    "add",
    "-b",
    promotionBranch,
    promotionPath,
    repo.target_head,
  );
  await git(app, "update-ref", recoveryRef, repo.target_head);

  await assert.rejects(
    WorkspaceSession.resume(deliveryConfig, session.manifestPath),
    /promotion was interrupted/,
  );
  const recovery = await WorkspaceSession.resume(
    deliveryConfig,
    session.manifestPath,
    { allowRecovery: true },
  );
  await recovery.recoverPromotion("test-prepare-recovery");

  await assert.rejects(git(app, "show-ref", "--verify", `refs/heads/${promotionBranch}`));
  await assert.rejects(readFile(join(promotionPath, "README.md"), "utf8"), /ENOENT/);
  await recovery.discard("test-prepare-recovery");
});
