import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const codexHelper = resolve(here, "../codex/client-id.sh");
const claudeHelper = resolve(here, "../claude-code/client-id.sh");

function resolveId(helper, host, hookSession, env = {}) {
  return execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; statewright_client_id "$2" "$3"',
      "statewright-client-id-test",
      helper,
      host,
      hookSession,
    ],
    {
      encoding: "utf8",
      env: {
        BASH_ENV: "/dev/null",
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        PPID: String(process.ppid),
        ...env,
      },
    },
  ).trim();
}

test("Codex and Claude package the same client identity resolver", () => {
  assert.equal(readFileSync(codexHelper, "utf8"), readFileSync(claudeHelper, "utf8"));
});

test("host session identity is stable across hook payloads and opaque on transport", () => {
  const first = resolveId(codexHelper, "codex", "hook-a", {
    CODEX_THREAD_ID: "codex-thread-a",
  });
  const second = resolveId(codexHelper, "codex", "hook-b", {
    CODEX_THREAD_ID: "codex-thread-a",
  });

  assert.equal(first, second);
  assert.match(first, /^swc_[a-f0-9]{32}$/);
  assert.ok(!first.includes("codex-thread-a"));
});

test("distinct host sessions and explicit identities receive distinct roots", () => {
  const codex = resolveId(codexHelper, "codex", "", {
    CODEX_THREAD_ID: "codex-thread-a",
  });
  const claude = resolveId(claudeHelper, "claude", "", {
    CLAUDE_SESSION_ID: "claude-session-a",
  });
  const explicit = resolveId(codexHelper, "codex", "", {
    STATEWRIGHT_CLIENT_ID: "embedded-client-a",
    CODEX_THREAD_ID: "ignored-thread",
  });

  assert.notEqual(codex, claude);
  assert.notEqual(codex, explicit);
  assert.notEqual(claude, explicit);
});

test("packaged proxies send the resolved client and branch identities", () => {
  const root = mkdtempSync(resolve(tmpdir(), "statewright-client-proxy-"));
  try {
    const bin = resolve(root, "bin");
    const curlLog = resolve(root, "curl-args");
    mkdirSync(bin, { recursive: true });
    const fakeCurl = resolve(bin, "curl");
    writeFileSync(
      fakeCurl,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STATEWRIGHT_CURL_LOG"\nprintf \'%s\' \'{"jsonrpc":"2.0","result":{"content":[]},"id":7}\'\n',
    );
    chmodSync(fakeCurl, 0o755);

    for (const [host, helper] of [["codex", codexHelper], ["claude-code", claudeHelper]]) {
      const identity = `${host}-session-a`;
      const expected = resolveId(helper, host === "codex" ? "codex" : "claude", "", {
        STATEWRIGHT_CLIENT_ID: identity,
      });
      execFileSync("bash", [resolve(here, `../${host}/mcp-proxy.sh`)], {
        encoding: "utf8",
        input: '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_status","arguments":{}},"id":7}\n',
        env: {
          BASH_ENV: "/dev/null",
          HOME: root,
          PATH: `${bin}:${process.env.PATH}`,
          STATEWRIGHT_API_KEY: "sw_live_test",
          STATEWRIGHT_BRANCH_SESSION_ID: "br_validation",
          STATEWRIGHT_CLIENT_ID: identity,
          STATEWRIGHT_CURL_LOG: curlLog,
          STATEWRIGHT_GATEWAY_URL: "https://gateway.invalid",
        },
      });
      const args = readFileSync(curlLog, "utf8");
      assert.match(args, new RegExp(`X-Statewright-Client-Id: ${expected}`));
      assert.match(args, /Mcp-Session-Id: br_validation/);
      assert.ok(!args.includes(identity));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex guard and capture hooks use the same local session directory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "statewright-client-hooks-"));
  try {
    const bin = resolve(root, "bin");
    const curlLog = resolve(root, "curl-args");
    mkdirSync(bin, { recursive: true });
    const fakeCurl = resolve(bin, "curl");
    writeFileSync(
      fakeCurl,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STATEWRIGHT_CURL_LOG"\nprintf \'%s\' \'{"id":"log-record"}\'\n',
    );
    chmodSync(fakeCurl, 0o755);

    const identity = "codex-hook-session-a";
    const resolved = resolveId(codexHelper, "codex", "", {
      STATEWRIGHT_CLIENT_ID: identity,
    });
    const sessionDir = resolve(root, ".statewright/sessions", resolved.slice(4, 20));
    const env = {
      BASH_ENV: "/dev/null",
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      STATEWRIGHT_API_KEY: "sw_live_test",
      STATEWRIGHT_CLIENT_ID: identity,
      STATEWRIGHT_CURL_LOG: curlLog,
    };

    execFileSync("bash", [resolve(here, "../codex/hook.sh"), "user-prompt"], {
      input: '{"session_id":"payload-session","prompt":"continue"}\n',
      env,
    });
    assert.doesNotThrow(() => readFileSync(resolve(sessionDir, ".session_hinted")));

    writeFileSync(resolve(sessionDir, ".capture_enabled"), "");
    writeFileSync(resolve(sessionDir, ".state_cache"), '{"state":"validate"}');
    writeFileSync(resolve(sessionDir, ".run_id"), "run-a");
    execFileSync("bash", [resolve(here, "../codex/capture.sh")], {
      input: '{"session_id":"payload-session","tool_name":"exec_command","tool_input":{},"tool_response":"ok","duration_ms":1}\n',
      env,
    });

    assert.equal(readFileSync(resolve(sessionDir, ".log_seq"), "utf8").trim(), "1");
    assert.match(readFileSync(curlLog, "utf8"), /workflow_logs\/records/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
