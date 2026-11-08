import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectCommandEvidence, literalArgv, literalInvocation, literalCommandList } from "../lib/command-evidence.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sw-command-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function vitest(root) {
  await mkdir(join(root, "node_modules/vitest"), { recursive: true });
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(join(root, "node_modules/vitest/package.json"), JSON.stringify({ name: "vitest", bin: "vitest.mjs" }));
  await writeFile(join(root, "node_modules/vitest/vitest.mjs"), "// fixture, never executed\n");
  await chmod(join(root, "node_modules/vitest/vitest.mjs"), 0o755);
  await symlink("../vitest/vitest.mjs", join(root, "node_modules/.bin/vitest"));
}
const inspect = (root, cmd) => collectCommandEvidence("exec_command", { cmd, workdir: root });

async function invokeCollector(path, request) {
  const child = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test("forwarded package arguments retain script and lifecycle execution units", async t => {
  const root = await fixture(t);
  await vitest(root);
  await writeFile(join(root, "package.json"), JSON.stringify({scripts: {
    "pretest:unit": "git status --short",
    "test:unit": "vitest",
    "posttest:unit": "git diff --check",
  }}));
  const command = "npm run test:unit -- --run src/components/__tests__/Example.spec.js --exclude '.agent-worktrees/**'";
  const proof = await inspect(root, command);
  assert.equal(proof.complete, true, proof.reason);
  assert.equal(proof.commands.length, 3);
  assert.equal(proof.commands[0].original, "git status --short");
  assert.equal(proof.commands[2].original, "git diff --check");
  assert.deepEqual(literalArgv(proof.commands[1].resolved), [
    "node_modules/.bin/vitest", "--run", "src/components/__tests__/Example.spec.js", "--exclude", ".agent-worktrees/**",
  ]);
  assert.equal(proof.files.some(file => file.path === "package.json"), true);
  for (const forwarded of ["--config ../outside.js", "--reporter evil", "--run --outputFile outside.json"]) {
    assert.equal((await inspect(root, `npm run test:unit -- ${forwarded}`)).complete, false);
  }
});

test("literal launcher parser rejects shell execution and malformed quoting", () => {
  assert.deepEqual(literalArgv("npx vitest run 'tests/a.spec.js'"), ["npx", "vitest", "run", "tests/a.spec.js"]);
  for (const text of ["task test && curl x", "task $(x)", "task `x`", "task test > x", "task 'test", "task test\nwhoami", "task te\\st"]) {
    assert.equal(literalArgv(text), null, text);
  }
});

test("command-list collection retains every branch and never executes a leaf", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/check.mjs"), "throw new Error('must never run');\n");
  for (const operator of ["&&", "||", ";", "|"]) {
    const command = `git diff --check ${operator} node scripts/check.mjs`;
    assert.deepEqual(literalCommandList(command), ["git diff --check", "node scripts/check.mjs"]);
    const proof = await inspect(root, command);
    assert.equal(proof.schema, "statewright/command-list-evidence/v1");
    assert.equal(proof.command, command);
    assert.equal(proof.leaves.length, 2);
    assert.equal(proof.leaves[0].evidence, null);
    assert.equal(proof.leaves[1].evidence.complete, true);
    assert.equal(proof.leaves[1].evidence.command, "node scripts/check.mjs");
    assert.equal(proof.leaves[1].evidence.requested_cwd, root);
  }
  for (const command of ["node scripts/check.mjs & unknown", "node scripts/check.mjs > output",
    "node scripts/check.mjs && $(unknown)", "node scripts/check.mjs &&", "node scripts/check.mjs;; unknown",
    "node scripts/check.mjs\nunknown", "(node scripts/check.mjs)", "NODE_OPTIONS=x node scripts/check.mjs && true"]) {
    assert.equal(literalCommandList(command), null, command);
    assert.equal(await inspect(root, command), null, command);
  }
  const unknown = await inspect(root, "node scripts/check.mjs && unknown_fixture --mutate");
  assert.equal(unknown.leaves[1].command, "unknown_fixture --mutate");
  assert.equal(unknown.leaves[1].evidence, null);
});

test("literal invocation normalizes assignments and transparent wrappers", () => {
  assert.deepEqual(literalInvocation("STATEWRIGHT_DIR='/workspace/statewright' command -- node scripts/preflight.mjs preflight"), {
    executable: "node", args: ["scripts/preflight.mjs", "preflight"],
    environment_names: ["STATEWRIGHT_DIR"], wrappers: ["command"],
  });
  assert.deepEqual(literalInvocation("env LC_ALL=C node --test tests/a.test.mjs"), {
    executable: "node", args: ["--test", "tests/a.test.mjs"],
    environment_names: ["LC_ALL"], wrappers: ["env"],
  });
  for (const text of [
    "NODE_OPTIONS=--require=evil node --test tests/a.test.mjs",
    "PATH=/tmp command node --test tests/a.test.mjs",
    "env -S node --test tests/a.test.mjs",
    "command -p node --test tests/a.test.mjs",
  ]) assert.equal(literalInvocation(text), null, text);
});

test("bare npx needs an installed matching local Vitest binary", async t => {
  const root = await fixture(t);
  const cmd = "npx vitest run tests/a.spec.js";
  assert.equal((await inspect(root, cmd)).complete, false);
  await vitest(root);
  const result = await inspect(root, cmd);
  assert.equal(result.complete, true);
  assert.equal(result.command, cmd);
  assert.equal(result.requested_cwd, root);
  assert.deepEqual(result.commands.map(({ original, resolved, cwd }) => ({ original, resolved, cwd })), [
    { original: cmd, resolved: "node_modules/.bin/vitest run tests/a.spec.js", cwd: "." },
  ]);
  assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  for (const arg of ["../escape.spec.js", "/tmp/a.spec.js", "--watch", "--config=outside.js", "--reporter=json", "-a.spec.js"]) {
    assert.equal((await inspect(root, `npx vitest run ${arg}`)).complete, false, arg);
  }
});

test("Vitest selection options retain literal glob values and installed-runner binding", async t => {
  const root = await fixture(t);
  await vitest(root);
  for (const selection of ["--exclude '**/.agent-worktrees/**'", "'--exclude=**/generated/**'", "--exclude '**/one/**' --exclude '**/two/**'"]) {
    const command = `npx vitest run ${selection} tests/a.spec.js`;
    const proof = await inspect(root, command);
    assert.equal(proof.complete, true, command);
    const expected = literalInvocation(command);
    const resolved = literalInvocation(proof.commands[0].resolved);
    assert.deepEqual(resolved.args, expected.args.slice(1));
    assert.equal(resolved.executable, "node_modules/.bin/vitest");
    assert.ok(proof.files.length >= 2);
  }
  for (const selection of ["--exclude", "--exclude --config", "--exclude=", "--exclude ../outside", "--exclude /outside",
    "--exclude '**/ok/**' --reporter=custom.js", "--exclude '**/ok/**' --config=other.js", "--exclude '**/ok/**' --watch"]) {
    assert.equal((await inspect(root, `npx vitest run ${selection}`)).complete, false, selection);
  }
  assert.equal(await inspect(root, "npx vitest run --exclude **/generated/** tests/a.spec.js"), null);
  assert.equal(await inspect(root, "npx vitest run --exclude '${SECRET}' tests/a.spec.js"), null);
});

test("collector entrypoint runs through a symlinked plugin cache", async t => {
  const root = await fixture(t);
  await vitest(root);
  const modulePath = fileURLToPath(new URL("../lib/command-evidence.mjs", import.meta.url));
  const alias = join(root, "plugin-lib");
  await symlink(dirname(modulePath), alias, "dir");
  const command = "npx vitest run tests/a.spec.js";
  const result = await invokeCollector(join(alias, "command-evidence.mjs"), {
    tool_name: "exec_command",
    cwd: root,
    tool_input: { cmd: command, workdir: root },
  });
  assert.equal(result.complete, true);
  assert.equal(result.command, command);
  assert.deepEqual(result.commands.map(({ original, resolved, cwd }) => ({ original, resolved, cwd })), [
    { original: command, resolved: "node_modules/.bin/vitest run tests/a.spec.js", cwd: "." },
  ]);
});

test("hash-binds a literal Node repository entrypoint without executing it", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/preflight.mjs"), "throw new Error('must never execute during inspection')\n");
  const command = "STATEWRIGHT_DIR=/workspace/statewright command -- node scripts/preflight.mjs preflight";
  const result = await inspect(root, command);
  assert.equal(result.complete, true);
  assert.deepEqual(result.invocation, literalInvocation(command));
  assert.deepEqual(result.commands.map(({ resolved, cwd }) => ({ resolved, cwd })), [{ resolved: command, cwd: "." }]);
  assert.ok(result.files.some(file => file.path === "scripts/preflight.mjs"));
  const implicit = await collectCommandEvidence("exec_command", {cmd: command}, {cwd: root});
  assert.equal(implicit.complete, false);
  assert.equal(implicit.reason, "absolute_cwd_required");
  for (const denied of [
    "node ../preflight.mjs", "node /tmp/preflight.mjs", "node --import=evil scripts/preflight.mjs",
    "NODE_OPTIONS=--require=evil node scripts/preflight.mjs", "env -S node scripts/preflight.mjs",
  ]) {
    const evidence = await inspect(root, denied);
    assert.ok(evidence == null || evidence.complete === false, denied);
  }
});

test("command-list envelope is byte bounded and diagnostic supports both schemas", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/check.mjs"), "throw new Error('never execute');\n");
  // Each leaf is individually valid, but repeated manifests exceed the total
  // envelope budget. A missing envelope must never mean permission granted.
  await writeFile(join(root, "Taskfile.yml"), `version: '3'\ntasks:\n  test:\n    cmds:\n${Array(32).fill("      - node scripts/check.mjs\n").join("")}`);
  assert.equal((await inspect(root, "task test")).complete, true);
  const proof = await inspect(root, Array(25).fill("task test").join(" && "));
  assert.equal(proof, null);
  const path = fileURLToPath(new URL("../scripts/inspect-command-evidence.mjs", import.meta.url));
  const child = spawn(process.execPath, [path, root, "git diff --check && node scripts/check.mjs"]);
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, errors);
  const report = JSON.parse(output);
  assert.equal(report.executed, false);
  assert.equal(report.units, 2);
  assert.equal(report.evidence_schema, "statewright/command-list-evidence/v1");
  assert.equal(report.complete, false); // collection is not authoritative admission
  assert.ok(!output.includes(root));
});

test("Taskfile commands and dependencies expand without executing them", async t => {
  const root = await fixture(t);
  await vitest(root);
  await writeFile(join(root, "Taskfile.yml"), "version: '3'\ntasks:\n  checks:\n    deps: [unit]\n    cmds:\n      - git status --short\n  unit:\n    cmds:\n      - npx vitest run {{.CLI_ARGS}}\n");
  const result = await inspect(root, "task checks");
  assert.equal(result.complete, true);
  assert.deepEqual(result.commands.map(unit => unit.resolved), ["node_modules/.bin/vitest run", "git status --short"]);
});

test("task directory flags select a bounded nested manifest", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "site/scripts"), { recursive: true });
  await writeFile(join(root, "site/scripts/check.mjs"), "export {}\n");
  await writeFile(join(root, "site/Taskfile.yml"), "version: '3'\ntasks:\n  check:\n    cmds: [node scripts/check.mjs preflight]\n");
  for (const command of ["task -d site check", "task --dir site check", "task --dir=site check"]) {
    const result = await inspect(root, command);
    assert.equal(result.complete, true, command);
    assert.ok(result.files.some(file => file.path === "site/Taskfile.yml"), command);
    assert.ok(result.files.some(file => file.path === "site/scripts/check.mjs"), command);
    assert.deepEqual(result.commands.map(unit => unit.cwd), ["site"], command);
  }
  for (const command of ["task -d ../outside check", "task --dir=/tmp check", "task -d site check extra"]) {
    const result = await inspect(root, command);
    assert.ok(result == null || result.complete === false, command);
  }
});

test("bare Vitest requires package-script PATH provenance", async t => {
  const root = await fixture(t);
  await vitest(root);
  await writeFile(join(root, "Taskfile.yml"), "version: '3'\ntasks:\n  unit:\n    cmds: [vitest run]\n");
  for (const command of ["vitest run", "task unit"]) {
    const result = await inspect(root, command);
    assert.equal(result.complete, false);
    assert.equal(result.reason, "runner_path_unresolved");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({scripts: {test: "task unit"}}));
  assert.equal((await inspect(root, "npm test")).complete, true);
});

test("npx package-bin precedence and workspaces cannot borrow local-bin evidence", async t => {
  const root = await fixture(t);
  await vitest(root);
  for (const pkg of [{bin: {vitest: "other.mjs"}}, {name: "vitest", bin: "other.mjs"}, {workspaces: ["packages/*"]}]) {
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const result = await inspect(root, "npx vitest run");
    assert.equal(result.complete, false);
    assert.equal(result.reason, "runner_configuration_unresolved");
  }
});

test("task names cannot conceal network/write commands", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "Taskfile.yml"), "version: '3'\ntasks:\n  test:unit:\n    cmds:\n      - curl https://example.invalid\n      - echo x > result.txt\n");
  const result = await inspect(root, "task test:unit");
  assert.equal(result.complete, true);
  assert.deepEqual(result.commands.map(unit => unit.resolved), ["curl https://example.invalid", "echo x > result.txt"]);
});

test("dynamic globals, includes, env, deferred commands and cycles stay unresolved", async t => {
  const root = await fixture(t);
  const variants = [
    "version: '3'\nvars:\n  VERSION:\n    sh: echo secret > marker\nenv:\n  VERSION: '{{.VERSION}}'\ntasks:\n  unit:\n    cmds: [git status]\n",
    "version: '3'\nincludes: {other: remote.yml}\ntasks: {}\n",
    "version: '3'\ntasks:\n  unit:\n    env: {NODE_OPTIONS: --require=evil}\n    cmds: [git status]\n",
    "version: '3'\ntasks:\n  unit:\n    cmds:\n      - defer: curl https://example.invalid\n",
    "version: '3'\ntasks:\n  unit:\n    deps: [other]\n  other:\n    deps: [unit]\n",
    "version: '3'\ntasks:\n  unit:\n    cmds: [git status]\n    cmds: [curl https://example.invalid]\n",
  ];
  for (const text of variants) {
    await writeFile(join(root, "Taskfile.yml"), text);
    const result = await inspect(root, "task unit");
    assert.equal(result.complete, false);
    assert.deepEqual(result.commands, []);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("package scripts include pre and post lifecycle effects", async t => {
  const root = await fixture(t);
  await vitest(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
    pretest: "curl https://example.invalid", test: "vitest run", posttest: "echo x > report.txt",
  }}));
  const result = await inspect(root, "npm test");
  assert.equal(result.complete, true);
  assert.deepEqual(result.commands.map(unit => unit.resolved), ["curl https://example.invalid", "node_modules/.bin/vitest run", "echo x > report.txt"]);
  await writeFile(join(root, ".npmrc"), "script-shell=untrusted\n");
  assert.equal((await inspect(root, "npm test")).complete, false);
});

test("symlinked manifests escaping cwd are rejected", async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, "package.json"), JSON.stringify({ scripts: { test: "git status" } }));
  await symlink(join(outside, "package.json"), join(root, "package.json"));
  const result = await inspect(root, "npm test");
  assert.equal(result.complete, false);
  assert.equal(result.reason, "symlink_escape");
});

test("unsupported wrapper flags never produce trusted evidence", async t => {
  const root = await fixture(t);
  for (const cmd of ["task --dir /tmp unit", "task unit -- --watch", "npm run test -- --watch", "env -i task unit"]) {
    const result = await inspect(root, cmd);
    assert.ok(result == null || result.complete === false, cmd);
  }
  assert.equal(await collectCommandEvidence("mcp__evil__exec_command", { cmd: "task unit", workdir: root }), null);
});
