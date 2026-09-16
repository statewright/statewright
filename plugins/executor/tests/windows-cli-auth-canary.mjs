// Windows W1 canary: authenticated vendor CLI feasibility on a hosted runner.
//
// Proves (or explicitly records the absence of) a real authenticated Codex
// or Claude Code session completing a minimal non-interactive turn on the
// windows-2022 runner image. This is the evidence boundary the bootstrap
// canaries (discovery, shims, routing) and the live gateway canary (executor
// bridge auth) do not cover: those never exercise a vendor-owned model turn.
//
// Credential contract (repo secrets, step-scoped, passed only to the vendor
// CLI child process, never to the managed supervisor or Statewright):
//   STATEWRIGHT_CANARY_CODEX_AUTH_JSON    base64 of a codex auth.json (ChatGPT login)
//   STATEWRIGHT_CANARY_OPENAI_API_KEY     plain OpenAI API key (fallback)
//   STATEWRIGHT_CANARY_CLAUDE_OAUTH_TOKEN long-lived Claude OAuth token
//   STATEWRIGHT_CANARY_ANTHROPIC_API_KEY  Anthropic API key (fallback)
//
// A vendor with no credential provisioned is reported as not_provisioned and
// does not fail the job: the receipt then documents the W1 boundary. A
// provisioned vendor whose turn fails does fail the job, because that is
// actionable infeasibility evidence, not a missing secret.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

if (process.platform !== "win32") {
  throw new Error("The Windows vendor CLI auth canary must run on a Windows runner.");
}

// npm global installs expose .cmd launchers on Windows runners. Bare names do
// not get PATHEXT resolution, so resolve the full launcher path first. Node
// 22's child_process can also reject batch (.cmd) launchers with spawn EINVAL
// (observed on windows-2022 with both the sync and async APIs), so every probe
// walks a strategy chain and records each strategy's outcome in the receipt:
//   s1_direct  execFile(launcher, args)      strongest Node-side spawn evidence
//   s2_cmd     cmd.exe /d /s /c "launcher"   classic batch invocation
//   s3_pwsh    pwsh -NoProfile -Command &    proven by this workflow's own
//                 "Verify Codex/Claude CLI" steps on the runner image
// The first successful strategy drives the probe; the table keeps any future
// launcher miss self-diagnosing.
function resolveLauncher(name) {
  if (process.platform !== "win32") return name;
  const exts = (process.env.PATHEXT ?? ".CMD;.EXE;.COM;.BAT").split(";").map((e) => e.toLowerCase());
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function execWithStrategy(strategy, launcher, args, env, timeoutMs) {
  const base = {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  let command;
  let cmdArgs;
  if (strategy === "s2_cmd") {
    command = "cmd";
    cmdArgs = ["/d", "/s", "/c", [launcher, ...args].map((part) => `"${part}"`).join(" ")];
  } else if (strategy === "s3_pwsh") {
    command = "pwsh";
    const script = [`& '${launcher.replaceAll("'", "''")}'`, ...args.map((a) => `'${String(a).replaceAll("'", "''")}'`)].join(" ");
    cmdArgs = ["-NoProfile", "-NonInteractive", "-Command", script];
  } else {
    command = launcher;
    cmdArgs = args;
  }
  try {
    const { stdout } = await execFileAsync(command, cmdArgs, base);
    return { ok: true, stdout: String(stdout).trim() };
  } catch (error) {
    const firstLine = [error?.code != null ? String(error.code) : "", String(error?.message ?? error)]
      .filter(Boolean)
      .join(" ")
      .split("\n")[0]
      .slice(0, 300);
    return { ok: false, error: firstLine, stdout: String(error?.stdout ?? "").trim(), stderr: String(error?.stderr ?? "").trim() };
  }
}

async function runCli(name, args, env = {}, timeoutMs = 240000) {
  const launcher = resolveLauncher(name) ?? (process.platform === "win32" ? `${name}.cmd` : name);
  const chain = process.platform === "win32" ? ["s1_direct", "s2_cmd", "s3_pwsh"] : ["s1_direct"];
  const strategies = {};
  let selected = null;
  for (const strategy of chain) {
    const started = Date.now();
    const result = await execWithStrategy(strategy, launcher, args, env, timeoutMs);
    strategies[strategy] = { ok: result.ok, latency_ms: Date.now() - started };
    if (result.ok) {
      strategies[strategy].stdout = result.stdout.slice(-400);
      if (!selected) {
        selected = strategy;
        break; // first success drives the probe; later strategies are not needed
      }
    } else {
      strategies[strategy].error = result.error;
      strategies[strategy].stdout = result.stdout.slice(-400);
      if (result.stderr) strategies[strategy].stderr = result.stderr.slice(-200);
    }
  }
  const chosen = selected ? strategies[selected] : strategies[chain[0]];
  return {
    launcher,
    spawn_strategy: selected,
    strategies,
    ok: Boolean(selected),
    stdout: chosen.stdout,
    error: selected ? undefined : chosen.error,
  };
}

const PROMPT = "Reply with exactly: ok";

const [codexVersionProbe, claudeVersionProbe] = await Promise.all([
  runCli("codex", ["--version"], {}, 30000),
  runCli("claude", ["--version"], {}, 30000),
]);
const codexVersion = codexVersionProbe.stdout || "unknown";
const claudeVersion = claudeVersionProbe.stdout || "unknown";

// A missing launcher on a provisioned vendor is actionable breakage in this
// step (the install/verify steps already passed), so record it distinctly.
function notProvisionedRow(probe, version) {
  const row = { credential: "none", status: "not_provisioned", version, launcher: probe.launcher, spawn_strategy: probe.spawn_strategy, strategies: probe.strategies };
  if (!probe.ok) row.version_error = probe.error;
  return row;
}

async function probeCodex() {
  const authJsonB64 = process.env.STATEWRIGHT_CANARY_CODEX_AUTH_JSON?.trim();
  const apiKey = process.env.STATEWRIGHT_CANARY_OPENAI_API_KEY?.trim();
  if (!authJsonB64 && !apiKey) {
    return notProvisionedRow(codexVersionProbe, codexVersion);
  }
  let env = {};
  let credential = "api_key";
  let scratch;
  if (authJsonB64) {
    credential = "auth_json";
    scratch = mkdtempSync(join(tmpdir(), "sw-codex-"));
    writeFileSync(join(scratch, "auth.json"), Buffer.from(authJsonB64, "base64").toString("utf8"));
    env = { CODEX_HOME: scratch };
  } else {
    env = { OPENAI_API_KEY: apiKey };
  }
  try {
    const probe = await runCli("codex", ["exec", "--skip-git-repo-check", PROMPT], env);
    return {
      credential,
      version: codexVersion,
      ...probe,
      ok: probe.ok && /(^|\n)\s*ok\s*\n?$/i.test(probe.stdout ?? ""),
    };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

async function probeClaude() {
  const oauthToken = process.env.STATEWRIGHT_CANARY_CLAUDE_OAUTH_TOKEN?.trim();
  const apiKey = process.env.STATEWRIGHT_CANARY_ANTHROPIC_API_KEY?.trim();
  if (!oauthToken && !apiKey) {
    return notProvisionedRow(claudeVersionProbe, claudeVersion);
  }
  const env = oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : { ANTHROPIC_API_KEY: apiKey };
  const probe = await runCli("claude", ["-p", PROMPT], env);
  return {
    credential: oauthToken ? "oauth_token" : "api_key",
    version: claudeVersion,
    ...probe,
    ok: probe.ok && /(^|\n)\s*ok\s*\n?$/i.test(probe.stdout ?? ""),
  };
}

const codex = await probeCodex();
const claude = await probeClaude();
const provisioned = [codex, claude].filter((row) => row.credential !== "none");

const receipt = {
  schema: "statewright/windows-cli-auth-canary/v1",
  runner: `${process.platform} ${process.arch}`,
  node: process.version,
  codex,
  claude,
};
console.log(JSON.stringify(receipt, null, 2));

for (const row of provisioned) {
  assert.equal(row.ok, true, `provisioned vendor ${row.credential} failed its authenticated turn: ${row.error ?? row.stdout ?? "no output"}`);
}

if (provisioned.length === 0) {
  console.log(
    "Windows vendor CLI auth canary: no vendor credentials provisioned; " +
      "W1 authenticated-session evidence remains not_provisioned on this runner.",
  );
} else {
  console.log(
    `Windows vendor CLI auth canary passed: ${provisioned.length} provisioned vendor(s) completed an authenticated turn on Windows.`,
  );
}
