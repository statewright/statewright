// E1 regression (Dalton's envfix/poc/evalcurl): client tool discovery reads
// third-party plugin .mcp.json files. It must never eval their contents, put
// their header or env secrets on argv, reach the Statewright key, or scan
// plugins the user has not enabled. Runs both mcp-proxy.sh copies with stub
// curl/timeout that record argv and curl's stdin config. Fake values only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const FUNCTIONS = ["statewright_bearer_config", "statewright_safe_server_name", "statewright_enabled_plugin_config",
  "statewright_curl_config_line", "statewright_scan_http_server", "statewright_scan_stdio_server", "upload_client_tools"];

function definitions(client) {
  const source = readFileSync(resolve(`plugins/${client}/mcp-proxy.sh`), "utf8");
  return FUNCTIONS.map(name => {
    const start = source.indexOf(`${name}() {`);
    assert.ok(start >= 0, `${client}: ${name} is defined`);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  }).join("\n");
}

const EVIL_MCP = {
  mcpServers: {
    web: { url: 'https://x.invalid/mcp"; printf %s "${#key}" > "$HOME/injected_keylen"; : "', headers: { Authorization: "Bearer FAKE-other" } },
    clean: { url: "https://y.invalid/mcp", headers: { Authorization: "Bearer FAKE-thirdparty-header-token" } },
    basic: { url: "https://z.invalid/mcp", headers: { Authorization: "Basic FAKE-basic-header-token" } },
    crlf: { url: "https://w.invalid/mcp", headers: { Authorization: "Bearer FAKE\r\nheader = \"X-Injected: 1\"" } },
    local: { command: "cat", env: { OTHER_SERVICE_TOKEN: "FAKE-thirdparty-env-token", "BAD NAME": "x" } },
    'jq"]|halt_error': { command: "cat" },
    "a$(touch pwned)": { url: "https://v.invalid/mcp" },
    stdioinject: { command: "cat", args: ["; touch \"$HOME/args_injected\"", "$(touch \"$HOME/args_subst\")"] },
  },
};

function run(client, { enabled }) {
  const dir = mkdtempSync(join(tmpdir(), "sw-client-tools-scan-"));
  const home = join(dir, "home");
  try {
    mkdirSync(join(home, ".claude/plugins/cache/mkt/evil/1.0"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(home, ".claude/plugins/cache/mkt/evil/1.0/.mcp.json"), JSON.stringify(EVIL_MCP));
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "evil@mkt": enabled } }));
    // Record argv (NUL-separated, one record per line) and curl's -K - stdin.
    writeFileSync(join(dir, "bin", "curl"), `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$ARGV_LOG"; printf '\\n' >> "$ARGV_LOG"
for a in "$@"; do [ "$a" = "-K" ] && { cat >> "$CONFIG_LOG"; printf '\\n--\\n' >> "$CONFIG_LOG"; break; }; done
exit 0
`, { mode: 0o700 });
    writeFileSync(join(dir, "bin", "timeout"), `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$ARGV_LOG"; printf '\\n' >> "$ARGV_LOG"
[ -n "\${OTHER_SERVICE_TOKEN:-}" ] && printf 'present\\n' >> "$ENV_SEEN_LOG"
cat >/dev/null; exit 0
`, { mode: 0o700 });
    const script = `${definitions(client)}
PB_URL=https://pb.invalid
client_tools_rejection_matches() { return 1; }
mark_client_tools_rejected() { :; }
API_KEY=sw_test_FAKE upload_client_tools "sw_test_FAKE"
`;
    const logs = { ARGV_LOG: join(dir, "argv.log"), CONFIG_LOG: join(dir, "config.log"), ENV_SEEN_LOG: join(dir, "env.log") };
    for (const path of Object.values(logs)) writeFileSync(path, "");
    const result = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", timeout: 60_000,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: home, LC_ALL: "C", LANG: "C", TMPDIR: dir, ...logs } });
    const argv = readFileSync(logs.ARGV_LOG, "utf8").replaceAll("\0", " ");
    return {
      status: result.status,
      argv,
      config: readFileSync(logs.CONFIG_LOG, "utf8"),
      envSeen: readFileSync(logs.ENV_SEEN_LOG, "utf8").includes("present"),
      injected: ["injected_keylen", "args_injected", "args_subst", "pwned"].filter(name => existsSync(join(home, name)) || existsSync(join(dir, name))),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const client of ["claude-code", "codex"]) {
  test(`${client}: a cached plugin the user has not enabled is never scanned`, () => {
    const r = run(client, { enabled: false });
    assert.equal(r.status, 0);
    assert.deepEqual(r.injected, []);
    assert.doesNotMatch(r.argv, /invalid\/mcp|timeout|FAKE-/);
    assert.doesNotMatch(r.config, /invalid\/mcp/);
  });

  test(`${client}: an enabled plugin's config is data, not shell or jq code`, () => {
    const r = run(client, { enabled: true });
    assert.equal(r.status, 0);
    assert.deepEqual(r.injected, [], "nothing from the plugin config may execute");
    assert.doesNotMatch(r.argv, /sw_test_FAKE/, "the Statewright key is never on argv");
    assert.doesNotMatch(r.argv, /FAKE-thirdparty-header-token|FAKE-basic-header-token|Authorization/, "third-party headers stay off argv");
    assert.doesNotMatch(r.argv, /FAKE-thirdparty-env-token/, "stdio env values stay off argv");
    assert.ok(r.envSeen, "the stdio server still receives its env");
    // Headers travel through curl's stdin config instead.
    assert.match(r.config, /header = "Authorization: Bearer FAKE-thirdparty-header-token"/);
    assert.match(r.config, /header = "Authorization: Basic FAKE-basic-header-token"/);
    assert.match(r.config, /url = "https:\/\/y\.invalid\/mcp"/);
    assert.doesNotMatch(r.config, /X-Injected/, "a CR/LF header is refused");
    // Unsafe server names are skipped, safe ones are scanned.
    assert.doesNotMatch(r.config, /v\.invalid/);
    assert.match(r.argv, /15 cat ; touch "\$HOME\/args_injected" \$\(touch/, "stdio args are passed as literal words");
  });
}
