import { createHash } from "node:crypto";
import { open, realpath, access } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "./command-yaml.generated.mjs";

const MAX_BYTES = 128 * 1024;
const MAX_COMMANDS = 32;
const TASK_FILES = ["Taskfile.yml", "Taskfile.yaml", "Taskfile.dist.yml", "Taskfile.dist.yaml",
  "taskfile.yml", "taskfile.yaml", "taskfile.dist.yml", "taskfile.dist.yaml"];
const object = value => value != null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const label = value => typeof value === "string" && /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*$/.test(value);
const fail = reason => { throw new Error(reason); };

// Only literal launcher argv is expanded. The gateway's AST still owns shell
// effect classification; this parser never executes or rewrites shell syntax.
export function literalArgv(command) {
  if (typeof command !== "string" || command.length > 8192 || /[\n\r\x00\\$`;&|<>()]/.test(command)) return null;
  const words = command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g);
  if (!words || words.join(" ").replace(/\s/g, "") !== command.replace(/\s/g, "")) return null;
  return words.map(word => word.replace(/'([^']*)'|"([^"]*)"/g, (_, a, b) => a ?? b));
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

/** Inspect fresh local bytes. Never spawn task/npm/npx or evaluate a template. */
export async function collectCommandEvidence(toolName, input, { cwd = process.cwd(), now = Date.now } = {}) {
  if (!["exec_command", "bash", "shell", "terminal", "run_command"].includes(String(toolName).toLowerCase())) return null;
  const command = input?.command ?? input?.cmd;
  const argv = literalArgv(command);
  if (!argv || !["task", "npm", "pnpm", "npx", "vitest"].includes(argv[0])) return null;
  // Runner flags and non-test package commands retain the ordinary classifier.
  if (argv[0] === "npx" && argv[1] !== "vitest") return null;
  if (["npm", "pnpm"].includes(argv[0]) && !(argv[1] === "run" || argv[1] === "test")) return null;
  const evidence = {
    schema: "statewright/local-command-evidence/v1", tool_name: toolName,
    command, requested_cwd: input.workdir ?? input.cwd ?? null,
    collected_at_ms: now(), complete: false, commands: [], files: [],
  };
  try {
    const requested = input.workdir ?? input.cwd ?? cwd;
    if (typeof requested !== "string" || !isAbsolute(requested)) fail("absolute_cwd_required");
    const root = await realpath(requested);
    evidence.cwd = root;
    const snapshots = [];
    async function bytes(path) {
      if (!inside(root, path)) fail("path_escape");
      const canonical = await realpath(path);
      if (!inside(root, canonical)) fail("symlink_escape");
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_BYTES) fail("file_not_bounded");
        const content = await handle.readFile();
        const after = await handle.stat();
        if (content.length > MAX_BYTES || before.mtimeMs !== after.mtimeMs || before.size !== after.size) fail("file_changed");
        const digest = createHash("sha256").update(content).digest("hex");
        evidence.files.push({ path: relative(root, canonical), sha256: digest });
        snapshots.push({ path, canonical, mtime: after.mtimeMs, size: after.size });
        return content.toString("utf8");
      } finally { await handle.close(); }
    }
    async function installedVitest() {
      // npm checks package-owned bins/workspaces before node_modules/.bin.
      // Those branches may populate the npx cache, even with a local bin present.
      try { await access(join(root, ".npmrc")); fail("runner_configuration_unresolved"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      try {
        const localPackage = JSON.parse(await bytes(join(root, "package.json")));
        if (localPackage.workspaces || object(localPackage.bin) && own(localPackage.bin, "vitest")
            || typeof localPackage.bin === "string" && localPackage.name === "vitest") fail("runner_configuration_unresolved");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const packagePath = join(root, "node_modules/vitest/package.json");
      const pkg = JSON.parse(await bytes(packagePath));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
      if (pkg.name !== "vitest" || typeof bin !== "string" || !/^[a-zA-Z0-9_.\/-]+$/.test(bin)
          || isAbsolute(bin) || bin.split("/").includes("..")) fail("runner_manifest_invalid");
      const target = await realpath(join(root, "node_modules/vitest", bin));
      const link = join(root, "node_modules/.bin/vitest");
      if (!inside(root, target) || await realpath(link) !== target) fail("runner_binding_mismatch");
      await access(link, constants.X_OK);
      await bytes(target);
      snapshots.push({ path: link, canonical: target });
    }
    async function leaf(text, stack = []) {
      if (evidence.commands.length >= MAX_COMMANDS || stack.length > 8) fail("expansion_limit");
      if (typeof text !== "string" || text.length > 8192) fail("command_invalid");
      const tokens = literalArgv(text);
      if (tokens?.[0] === "task") return task(tokens, stack);
      if (["npm", "pnpm"].includes(tokens?.[0])) return script(tokens, stack);
      if (tokens?.[0] === "npx" || tokens?.[0] === "vitest") {
        // Only package-script execution establishes node_modules/.bin on PATH.
        // A bare shell/Taskfile `vitest` may resolve to an unrelated global bin.
        if (tokens[0] === "vitest" && !stack.some(item => item.startsWith("script:"))) fail("runner_path_unresolved");
        const args = tokens[0] === "npx" ? tokens.slice(2) : tokens.slice(1);
        if ((tokens[0] === "npx" && tokens[1] !== "vitest") || args[0] !== "run"
            || args.slice(1).some(arg => !/^[a-zA-Z0-9_][a-zA-Z0-9_.\/-]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)
              || arg.split("/").some(part => ["", ".", ".."].includes(part)))) fail("network_runner_unresolved");
        await installedVitest();
        evidence.commands.push({ original: text, resolved: ["node_modules/.bin/vitest", ...args].join(" ") });
      } else {
        if (/{{|}}/.test(text)) fail("template_unresolved");
        evidence.commands.push({ original: text, resolved: text });
      }
    }
    let manifest;
    async function task(tokens, stack) {
      if (stack.length > 8 || snapshots.length > 64) fail("expansion_limit");
      if (tokens.length !== 2 || !label(tokens[1])) fail("task_argv_unresolved");
      if (stack.includes(`task:${tokens[1]}`)) fail("task_cycle");
      if (!manifest) {
        let found = null;
        for (const name of TASK_FILES) {
          try { await access(join(root, name)); found = name; break; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (!found) fail("task_manifest_missing");
        const doc = parseDocument(await bytes(join(root, found)), { uniqueKeys: true, strict: true });
        if (doc.errors.length || doc.warnings.length) fail("task_yaml_invalid");
        manifest = doc.toJS({ maxAliasCount: 0 });
        if (!object(manifest) || String(manifest.version) !== "3" || !object(manifest.tasks)) fail("task_manifest_invalid");
        if (Object.keys(manifest).some(key => !["version", "tasks", "silent"].includes(key))) fail("task_global_effects_unresolved");
      }
      const entry = manifest.tasks[tokens[1]];
      if (!object(entry) || Object.keys(entry).some(key => !["desc", "summary", "cmds", "deps", "silent", "internal"].includes(key))) fail("task_effects_unresolved");
      const next = [...stack, `task:${tokens[1]}`];
      if (entry.deps != null && !Array.isArray(entry.deps)) fail("task_dependencies_invalid");
      for (const dependency of entry.deps ?? []) {
        const name = typeof dependency === "string" ? dependency
          : object(dependency) && Object.keys(dependency).length === 1 ? dependency.task : null;
        if (!label(name)) fail("task_dependency_unresolved");
        await task(["task", name], next);
      }
      if (entry.cmds != null && !Array.isArray(entry.cmds)) fail("task_commands_invalid");
      for (const item of entry.cmds ?? []) {
        if (object(item) && Object.keys(item).length === 1 && own(item, "task")) {
          await task(["task", item.task], next);
        } else {
          let text = typeof item === "string" ? item
            : object(item) && Object.keys(item).length === 1 ? item.cmd : null;
          if (typeof text !== "string") fail("task_command_unresolved");
          // Exactly empty CLI_ARGS follows from the two-argument task grammar.
          text = text.replaceAll("{{.CLI_ARGS}}", "");
          await leaf(text.trim(), next);
        }
      }
    }
    async function script(tokens, stack) {
      if (stack.length > 8 || snapshots.length > 64) fail("expansion_limit");
      try { await access(join(root, ".npmrc")); fail("package_script_config_unresolved"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const name = tokens.length === 2 && tokens[1] === "test" ? "test"
        : tokens.length === 3 && tokens[1] === "run" ? tokens[2] : null;
      if (!label(name) || stack.includes(`script:${name}`)) fail("package_script_unresolved");
      const pkg = JSON.parse(await bytes(join(root, "package.json")));
      if (!object(pkg.scripts) || !own(pkg.scripts, name)) fail("package_script_missing");
      // Lifecycle hooks are real execution units, including arbitrary scripts.
      // pnpm hook behavior is configuration-dependent, so conservatively include them.
      for (const key of [`pre${name}`, name, `post${name}`]) {
        if (own(pkg.scripts, key)) await leaf(pkg.scripts[key], [...stack, `script:${name}`]);
      }
    }
    await leaf(command);
    if (!evidence.commands.length) fail("empty_expansion");
    // Detect ordinary edits/replaced symlinks during inspection. This is not a
    // sandbox or protection against a malicious process under the same account.
    for (const snapshot of snapshots) {
      if (await realpath(snapshot.path) !== snapshot.canonical) fail("file_changed");
      if (snapshot.mtime != null) {
        const handle = await open(snapshot.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const stat = await handle.stat(); if (stat.mtimeMs !== snapshot.mtime || stat.size !== snapshot.size) fail("file_changed"); }
        finally { await handle.close(); }
      }
    }
    evidence.complete = true;
  } catch (error) {
    // Fixed reason vocabulary only; never include parser errors, paths or bytes.
    const known = /^(?:absolute_cwd_required|path_escape|symlink_escape|file_not_bounded|file_changed|runner_manifest_invalid|runner_binding_mismatch|runner_configuration_unresolved|runner_path_unresolved|expansion_limit|command_invalid|network_runner_unresolved|template_unresolved|task_[a-z_]+|package_script_[a-z_]+|empty_expansion)$/;
    evidence.reason = known.test(error.message) ? error.message : "local_evidence_unavailable";
    evidence.commands = [];
  }
  return evidence;
}

// A hook-owned entrypoint. Codex local-model runs expose plugin caches through
// symlinks, while Node canonicalizes import.meta.url. Canonicalize both sides
// so an installed collector invoked through that cache alias still runs.
const invokedAsEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

// Strip any model-provided evidence before collecting.
if (invokedAsEntrypoint) {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("input_limit");
  }
  const request = JSON.parse(text);
  const evidence = await collectCommandEvidence(request.tool_name, request.tool_input ?? {}, { cwd: request.cwd ?? process.cwd() });
  process.stdout.write(JSON.stringify(evidence));
}
