import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { safeGitCloseout } from "../lib/git-closeout.mjs";

const GIT = "/usr/bin/git";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "statewright-git-closeout-"));
  execFileSync(GIT, ["init", "-q", root]);
  execFileSync(GIT, ["-C", root, "config", "user.name", "Statewright Test"]);
  execFileSync(GIT, ["-C", root, "config", "user.email", "test@statewright.invalid"]);
  await writeFile(join(root, "README.md"), "baseline\n");
  execFileSync(GIT, ["-C", root, "add", "README.md"]);
  execFileSync(GIT, ["-C", root, "commit", "-q", "-m", "baseline"]);
  return root;
}

test("safe closeout commits only explicit regular files and leaves a clean tree", async () => {
  const root = await repository();
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "one.md"), "one\n");
    await writeFile(join(root, "docs", "two.md"), "two\n");
    const receipt = await safeGitCloseout({
      cwd: root,
      gitPath: GIT,
      message: "docs: bounded closeout",
      paths: ["docs/one.md", "docs/two.md"],
    });
    assert.match(receipt.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(receipt.paths, ["docs/one.md", "docs/two.md"]);
    assert.equal(receipt.index_updated, true);
    assert.equal(receipt.working_tree_clean, true);
    assert.deepEqual(receipt.warnings, []);
    assert.equal(execFileSync(GIT, ["-C", root, "status", "--porcelain"]).toString(), "");
    assert.match(execFileSync(GIT, ["-C", root, "show", "--format=", "--name-only", "HEAD"]).toString(), /docs\/one\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe closeout serializes the shared index and aborts before HEAD on concurrent worktree dirt", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "owned.md"), "owned\n");
    const before = execFileSync(GIT, ["-C", root, "rev-parse", "HEAD"]).toString().trim();
    let addWasBlocked = false;
    const receipt = await safeGitCloseout({
      cwd: root,
      gitPath: GIT,
      message: "test: serialize index",
      paths: ["owned.md"],
      testHooks: {
        async afterIndexLock() {
          await writeFile(join(root, "raced.md"), "race\n");
          try {
            execFileSync(GIT, ["-C", root, "add", "--", "raced.md"], { stdio: "pipe" });
          } catch {
            addWasBlocked = true;
          }
          await rm(join(root, "raced.md"));
        },
      },
    });
    assert.equal(addWasBlocked, true);
    assert.notEqual(receipt.commit, before);

    await writeFile(join(root, "next.md"), "next\n");
    const committed = execFileSync(GIT, ["-C", root, "rev-parse", "HEAD"]).toString().trim();
    await assert.rejects(
      safeGitCloseout({
        cwd: root,
        gitPath: GIT,
        message: "test: reject race",
        paths: ["next.md"],
        testHooks: {
          async beforeFinalVerification() {
            await writeFile(join(root, "concurrent.md"), "concurrent\n");
          },
        },
      }),
      /concurrent unrelated changes/,
    );
    assert.equal(execFileSync(GIT, ["-C", root, "rev-parse", "HEAD"]).toString().trim(), committed);
    await rm(join(root, "concurrent.md"));
    assert.equal(execFileSync(GIT, ["-C", root, "status", "--porcelain"]).toString(), "?? next.md\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe closeout reports post-commit publication failure without reporting a failed commit", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "owned.md"), "owned\n");
    const before = execFileSync(GIT, ["-C", root, "rev-parse", "HEAD"]).toString().trim();
    const receipt = await safeGitCloseout({
      cwd: root,
      gitPath: GIT,
      platform: "win32",
      message: "test: durable receipt",
      paths: ["owned.md"],
      testHooks: {
        beforeIndexPublish() {
          throw new Error("injected publication fault");
        },
      },
    });
    assert.notEqual(receipt.commit, before);
    assert.equal(receipt.index_updated, false);
    assert.equal(receipt.working_tree_clean, false);
    assert.match(receipt.warnings.join("\n"), /injected publication fault/);
    assert.equal(execFileSync(GIT, ["-C", root, "rev-parse", "HEAD"]).toString().trim(), receipt.commit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe closeout never executes repository diff or textconv helpers", async () => {
  const root = await repository();
  const sentinel = join(root, ".git", "diff-driver-ran");
  const driver = join(root, ".git", "evil-diff.sh");
  try {
    await writeFile(join(root, ".gitattributes"), "owned.md diff=evil\n");
    await writeFile(join(root, "owned.md"), "baseline\n");
    execFileSync(GIT, ["-C", root, "add", ".gitattributes", "owned.md"]);
    execFileSync(GIT, ["-C", root, "commit", "-q", "-m", "configure diff fixture"]);
    await writeFile(
      driver,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(sentinel)}\ncat "$1"\n`,
    );
    await chmod(driver, 0o755);
    execFileSync(GIT, ["-C", root, "config", "diff.evil.textconv", driver]);
    await writeFile(join(root, "owned.md"), "changed\n");

    execFileSync(GIT, ["-C", root, "diff"], { stdio: "pipe" });
    assert.equal(await readFile(sentinel, "utf8"), "ran");
    await rm(sentinel);

    const receipt = await safeGitCloseout({
      cwd: root,
      gitPath: GIT,
      message: "test: suppress diff drivers",
      paths: ["owned.md"],
    });
    assert.equal(receipt.working_tree_clean, true);
    await assert.rejects(readFile(sentinel), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe closeout rejects traversal, symlinks, and unrelated dirt", async () => {
  const root = await repository();
  const outside = await mkdtemp(join(tmpdir(), "statewright-git-closeout-outside-"));
  try {
    await writeFile(join(root, "owned.md"), "owned\n");
    await writeFile(join(root, "unrelated.md"), "unrelated\n");
    await writeFile(join(outside, "secret"), "secret\n");
    await symlink(join(outside, "secret"), join(root, "linked.md"));
    await assert.rejects(
      safeGitCloseout({ cwd: root, gitPath: GIT, message: "test", paths: ["../secret"] }),
      /parent components/,
    );
    await assert.rejects(
      safeGitCloseout({ cwd: root, gitPath: GIT, message: "test", paths: ["linked.md"] }),
      /unrelated working-tree changes|symbolic link/,
    );
    await assert.rejects(
      safeGitCloseout({ cwd: root, gitPath: GIT, message: "test", paths: ["owned.md"] }),
      /unrelated working-tree changes/,
    );
    assert.equal(await readFile(join(outside, "secret"), "utf8"), "secret\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
