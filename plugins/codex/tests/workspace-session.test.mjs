import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { WorkspaceSession } from "../scripts/lib/workspace-session.mjs";

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

function config(root, repositories) {
  return {
    configPath: join(root, "delivery.json"),
    workspace: {
      mode: "git_worktree",
      root: join(root, "runs"),
      repositories,
    },
    preview: {
      driver: "/usr/bin/true",
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
    config(root, [
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

  session.manifest.promotion.status = "complete";
  await session.saveManifest();
  await session.cleanup();
  assert.match((await git(app, "status", "--porcelain")).stdout, /dirty\.txt/);
});

test("promotion refuses a dirty checked-out target branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-dirty-"));
  const app = await createRepository(root, "app");
  const session = await WorkspaceSession.prepare(
    config(root, [
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
    config(root, [
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
  assert.match((await git(app, "log", "-1", "--pretty=%s")).stdout, /promote test/);
  await session.cleanup();
});

test("promotion keeps a detached merged-target snapshot when target is not checked out", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-promotion-detached-"));
  const app = await createRepository(root, "app");
  await git(app, "checkout", "--detach");
  const session = await WorkspaceSession.prepare(
    config(root, [
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
