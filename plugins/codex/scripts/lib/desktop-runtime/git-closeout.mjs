#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GIT_CLOSEOUT_MODULE_PATH = fileURLToPath(import.meta.url);

const MAX_FILES = 32;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 160;
function baseGitConfig(platform) {
  return [
    "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false",
    "-c", "maintenance.auto=false",
  ];
}

function gitEnvironment(source = process.env, platform = process.platform, overrides = {}) {
  const environment = {
    PATH: platform === "win32" ? (source.PATH ?? source.Path ?? "") : "/usr/bin:/bin",
    HOME: source.HOME ?? homedir(),
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...overrides,
  };
  if (platform === "win32") {
    for (const name of ["PATHEXT", "SystemRoot", "ComSpec"]) {
      if (source[name]) environment[name] = source[name];
    }
  }
  for (const name of [
    "XDG_CONFIG_HOME",
    "USER",
    "LOGNAME",
    "EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

function runGit(gitPath, cwd, args, {
  input,
  allowedExitCodes = [0],
  environment = {},
  platform = process.platform,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(gitPath, [...baseGitConfig(platform), ...args], {
      cwd,
      env: gitEnvironment(process.env, platform, environment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      const output = Buffer.concat(stdout);
      const error = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000);
      if (!allowedExitCodes.includes(code)) {
        reject(new Error(`git ${args[0]} failed (${code}): ${error || "no diagnostic"}`));
        return;
      }
      resolvePromise({ code, stdout: output, stderr: error });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function validateMessage(message) {
  if (!message || Buffer.byteLength(message) > MAX_MESSAGE_BYTES || /[\u0000-\u001f\u007f]/.test(message)) {
    throw new Error(`Commit message must be 1-${MAX_MESSAGE_BYTES} printable bytes.`);
  }
}

function validateRelativePath(path) {
  if (!path || isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Closeout path must be a printable repository-relative path: ${JSON.stringify(path)}`);
  }
  const components = path.split("/");
  if (components.some(component => !component || component === "." || component === "..")) {
    throw new Error(`Closeout path cannot contain empty, dot, or parent components: ${path}`);
  }
  return components;
}

function withinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function readOwnedRegularFile(root, path) {
  const components = validateRelativePath(path);
  let cursor = root;
  for (const component of components) {
    cursor = join(cursor, component);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`Closeout path traverses a symbolic link: ${path}`);
  }
  const canonical = await realpath(cursor);
  if (!withinRoot(root, canonical)) throw new Error(`Closeout path escapes the repository: ${path}`);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(canonical, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Closeout path is not a regular file: ${path}`);
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`Closeout file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    return {
      bytes: await handle.readFile(),
      mode: metadata.mode & 0o111 ? "100755" : "100644",
    };
  } finally {
    await handle.close();
  }
}

function dirtyPaths(statusOutput) {
  return statusOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(record => record.slice(3));
}

async function resolveIndexPath(gitPath, root, platform) {
  const result = await runGit(gitPath, root, ["rev-parse", "--git-path", "index"]);
  const named = result.stdout.toString("utf8").trim();
  return isAbsolute(named) ? named : resolve(root, named);
}

function exactPathSet(actual, expected) {
  if (actual.length !== expected.size) return false;
  return actual.every(path => expected.has(path));
}

async function publishIndex(lock, isolatedIndex) {
  const bytes = await readFile(isolatedIndex);
  await lock.handle.truncate(0);
  await lock.handle.writeFile(bytes);
  await lock.handle.sync();
  await lock.handle.close();
  lock.closed = true;
  await rename(lock.path, lock.indexPath);
  lock.published = true;
}

async function releaseIndexLock(lock) {
  if (!lock) return;
  if (!lock.closed) {
    await lock.handle.close().catch(() => {});
    lock.closed = true;
  }
  if (!lock.published) await rm(lock.path, { force: true }).catch(() => {});
}

export async function safeGitCloseout({
  cwd = process.cwd(),
  message,
  paths,
  gitPath = process.platform === "win32" ? "git.exe" : "/usr/bin/git",
  platform = process.platform,
  testHooks = {},
} = {}) {
  validateMessage(message);
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    throw new Error(`Closeout requires 1-${MAX_FILES} explicit file paths.`);
  }
  if (new Set(paths).size !== paths.length) throw new Error("Closeout paths must be unique.");
  paths.forEach(validateRelativePath);

  const requestedCwd = await realpath(cwd);
  const rootResult = await runGit(gitPath, requestedCwd, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(rootResult.stdout.toString("utf8").trim());
  if (requestedCwd !== root) throw new Error("Run closeout from the repository root.");

  const indexPath = await resolveIndexPath(gitPath, root, platform);
  const lock = {
    indexPath,
    path: `${indexPath}.lock`,
    handle: await open(`${indexPath}.lock`, "wx", 0o600),
    closed: false,
    published: false,
  };
  const isolatedIndex = `${indexPath}.statewright-${process.pid}-${randomUUID()}`;
  let committed = null;
  try {
    await testHooks.afterIndexLock?.({ root, indexPath });
    const staged = await runGit(gitPath, root, [
      "diff", "--no-ext-diff", "--no-textconv", "--cached", "--quiet", "--exit-code",
    ], {
      allowedExitCodes: [0, 1],
      platform,
    });
    if (staged.code !== 0) throw new Error("Closeout requires an initially empty Git index.");

    const status = await runGit(gitPath, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { platform });
    const allowedPaths = new Set(paths);
    const unrelated = dirtyPaths(status.stdout).filter(path => !allowedPaths.has(path));
    if (unrelated.length) throw new Error(`Closeout found unrelated working-tree changes: ${unrelated.join(", ")}`);

    const oldHeadResult = await runGit(gitPath, root, ["rev-parse", "HEAD"], { platform });
    const oldHead = oldHeadResult.stdout.toString("ascii").trim();
    const indexEnvironment = { GIT_INDEX_FILE: isolatedIndex };
    await runGit(gitPath, root, ["read-tree", oldHead], { environment: indexEnvironment, platform });

    const files = [];
    for (const path of paths) files.push({ path, ...(await readOwnedRegularFile(root, path)) });
    const objects = [];
    for (const file of files) {
      const result = await runGit(gitPath, root, ["hash-object", "-w", "--stdin"], {
        input: file.bytes,
        platform,
      });
      const object = result.stdout.toString("ascii").trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)) throw new Error("Git returned an invalid object ID.");
      objects.push({ ...file, object });
    }

    for (const file of objects) {
      await runGit(gitPath, root, [
        "update-index",
        "--add",
        "--cacheinfo",
        `${file.mode},${file.object},${file.path}`,
      ], { environment: indexEnvironment, platform });
    }
    await runGit(gitPath, root, [
      "diff", "--no-ext-diff", "--no-textconv", "--cached", "--check",
    ], { environment: indexEnvironment, platform });
    const stagedPaths = await runGit(gitPath, root, [
      "diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "-z", oldHead,
    ], {
      environment: indexEnvironment,
      platform,
    });
    const actualPaths = stagedPaths.stdout.toString("utf8").split("\0").filter(Boolean);
    if (!exactPathSet(actualPaths, allowedPaths)) {
      throw new Error("Isolated index contains paths outside the explicit closeout set.");
    }

    await testHooks.beforeFinalVerification?.({ root, indexPath });
    const finalCandidateStatus = await runGit(
      gitPath,
      root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { platform },
    );
    const finalUnrelated = dirtyPaths(finalCandidateStatus.stdout).filter(path => !allowedPaths.has(path));
    if (finalUnrelated.length) {
      throw new Error(`Closeout found concurrent unrelated changes: ${finalUnrelated.join(", ")}`);
    }
    for (const file of objects) {
      const current = await readOwnedRegularFile(root, file.path);
      if (!current.bytes.equals(file.bytes) || current.mode !== file.mode) {
        throw new Error(`Closeout path changed during transaction: ${file.path}`);
      }
    }

    const treeResult = await runGit(gitPath, root, ["write-tree"], {
      environment: indexEnvironment,
      platform,
    });
    const tree = treeResult.stdout.toString("ascii").trim();
    const commitResult = await runGit(gitPath, root, ["commit-tree", tree, "-p", oldHead], {
      input: Buffer.from(`${message}\n`, "utf8"),
      platform,
    });
    committed = commitResult.stdout.toString("ascii").trim();
    await runGit(gitPath, root, ["update-ref", "HEAD", committed, oldHead], { platform });
  } catch (error) {
    await releaseIndexLock(lock);
    await rm(isolatedIndex, { force: true }).catch(() => {});
    throw error;
  }

  const warnings = [];
  let indexUpdated = false;
  try {
    await testHooks.beforeIndexPublish?.({ root, indexPath, commit: committed });
    await publishIndex(lock, isolatedIndex);
    indexUpdated = true;
  } catch (error) {
    warnings.push(`commit created but index publication failed: ${error.message}`);
    await releaseIndexLock(lock);
  }
  await rm(isolatedIndex, { force: true }).catch(() => {});

  let workingTreeClean = false;
  try {
    const finalStatus = await runGit(
      gitPath,
      root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { platform },
    );
    workingTreeClean = finalStatus.stdout.length === 0;
    if (!workingTreeClean) warnings.push("commit created but the working tree is not clean");
  } catch (error) {
    warnings.push(`commit created but final status could not be read: ${error.message}`);
  }
  return {
    commit: committed,
    paths: [...paths],
    index_updated: indexUpdated,
    working_tree_clean: workingTreeClean,
    warnings,
  };
}

function parseCli(argv) {
  if (argv[0] !== "--message" || !argv[1] || argv[2] !== "--") {
    throw new Error("Usage: statewright-git-closeout --message <message> -- <path> [path ...]");
  }
  return { message: argv[1], paths: argv.slice(3) };
}

if (process.argv[1] && resolve(process.argv[1]) === GIT_CLOSEOUT_MODULE_PATH) {
  safeGitCloseout(parseCli(process.argv.slice(2)))
    .then(receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch(error => {
      process.stderr.write(`statewright-git-closeout: ${error.message}\n`);
      process.exitCode = 1;
    });
}
