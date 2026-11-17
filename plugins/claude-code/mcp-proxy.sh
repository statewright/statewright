#!/usr/bin/env bash
# Stdio MCP proxy — forwards JSON-RPC to statewright gateway with auth from disk
# Used as `type: "command"` MCP server in plugin .mcp.json
# No OAuth, no static auth headers — reads key dynamically from ~/.statewright/api_key

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATEWRIGHT_DIR="${HOME}/.statewright"
GW_URL="${STATEWRIGHT_GATEWAY_URL:-}"
[ -n "$GW_URL" ] || GW_URL=$(cat "$STATEWRIGHT_DIR/gateway_url" 2>/dev/null || true)
GW_URL="${GW_URL:-https://mcp.statewright.ai}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
KEY_FILE="$STATEWRIGHT_DIR/api_key"
INVALID_KEY_SENTINEL="$STATEWRIGHT_DIR/invalid_api_key"
MISSING_KEY_SENTINEL="$STATEWRIGHT_DIR/missing_api_key_prompted"
# shellcheck source=client-id.sh
source "${SCRIPT_DIR}/client-id.sh"

# Managed launchers hand the local MCP bridge token over as a 0600 file so it
# never sits in the Claude Code environment that its Bash tool and agent
# commands inherit. Load it into an unexported shell variable;
# STATEWRIGHT_MANAGED_MCP_TOKEN is the legacy carrier from older launchers.
# The file must be a regular file (not a symlink) owned by this user with no
# group/other permission bits; anything else is ignored.
statewright_private_token_file() {
  local path="$1" mode=""
  [ -n "$path" ] && [ -f "$path" ] && [ ! -L "$path" ] && [ -O "$path" ] || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || mode=$(stat -f '%Lp' "$path" 2>/dev/null) || return 1
  case "$mode" in 400|600) return 0 ;; *) return 1 ;; esac
}
STATEWRIGHT_MANAGED_MCP_BEARER="${STATEWRIGHT_MANAGED_MCP_TOKEN:-}"
if [ -z "$STATEWRIGHT_MANAGED_MCP_BEARER" ] && statewright_private_token_file "${STATEWRIGHT_MANAGED_MCP_TOKEN_FILE:-}"; then
  IFS= read -r STATEWRIGHT_MANAGED_MCP_BEARER < "$STATEWRIGHT_MANAGED_MCP_TOKEN_FILE" || true
fi
export -n STATEWRIGHT_MANAGED_MCP_BEARER 2>/dev/null || true
# Pass bearer credentials to curl through a config stream, not argv (ps).
# Reject CR/LF so a legacy env token cannot inject additional curl config.
statewright_bearer_config() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf 'header = "Authorization: Bearer %s"\n' "$value"
}


key_fingerprint() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  fi
}

invalid_key_matches() {
  [ -f "$INVALID_KEY_SENTINEL" ] &&
    [ "$(cat "$INVALID_KEY_SENTINEL" 2>/dev/null)" = "$(key_fingerprint "$1")" ]
}

open_keys_page() {
  local url="${1:-https://statewright.ai/keys}"
  local -a browser_command=()
  [ "${STATEWRIGHT_NO_BROWSER:-false}" = "true" ] && return 1
  if [ "${OS:-}" = "Windows_NT" ] && command -v powershell.exe >/dev/null 2>&1; then
    if [ -n "${STATEWRIGHT_BROWSER_OPEN_PROBE:-}" ]; then
      # Use an explicit PowerShell argument array so query strings survive
      # Windows Start-Process parsing (notably the `=` in redirect=/keys).
      browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '${STATEWRIGHT_BROWSER_OPEN_PROBE}' -ArgumentList @('\"$url\"') -Wait")
    else
      browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url'")
    fi
  elif command -v open >/dev/null 2>&1; then browser_command=(open "$url")
  elif command -v xdg-open >/dev/null 2>&1; then browser_command=(xdg-open "$url")
  elif command -v wslview >/dev/null 2>&1; then browser_command=(wslview "$url")
  elif command -v powershell.exe >/dev/null 2>&1; then browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url'")
  fi
  [ ${#browser_command[@]} -gt 0 ] || return 1
  if [ -n "${STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH:-}" ]; then
    printf '%s\n' "${browser_command[@]}" >> "$STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH"
  else
    "${browser_command[@]}" >/dev/null 2>&1
  fi
}

prompt_missing_key() {
  mkdir -p "$STATEWRIGHT_DIR" 2>/dev/null || return 0
  if [ ! -f "$MISSING_KEY_SENTINEL" ]; then
    if open_keys_page 'https://statewright.ai/signup?redirect=%2Fkeys'; then
      : > "$MISSING_KEY_SENTINEL"
      chmod 600 "$MISSING_KEY_SENTINEL"
    fi
  fi
}

mark_invalid_key() {
  local fingerprint
  fingerprint=$(key_fingerprint "$1")
  mkdir -p "$STATEWRIGHT_DIR" 2>/dev/null || return 0
  if [ "$(cat "$INVALID_KEY_SENTINEL" 2>/dev/null || true)" != "$fingerprint" ]; then
    if open_keys_page; then
      printf '%s\n' "$fingerprint" > "$INVALID_KEY_SENTINEL"
      chmod 600 "$INVALID_KEY_SENTINEL"
    fi
  fi
}

inject_claude_local_tools() {
  local response="$1"
  local search='{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting. Returns relevant doc snippets.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}'
  printf '%s' "$response" | jq -c --argjson s "$search" '
    .result.tools = ([.result.tools[] | select(.name != "statewright_search_docs")] + [$s])
  ' 2>/dev/null || printf '%s' "$response"
}

run_claude_local_tool() {
  local line="$1" tool_name
  tool_name=$(printf '%s' "$line" | jq -r '.params.name // empty' 2>/dev/null)
  [ "$tool_name" = "statewright_search_docs" ] || return 1
  env -u STATEWRIGHT_MANAGED_MCP_URL -u STATEWRIGHT_MANAGED_MCP_TOKEN -u STATEWRIGHT_MANAGED_MCP_TOKEN_FILE \
    -u STATEWRIGHT_ADAPTER_URL -u STATEWRIGHT_ADAPTER_TOKEN "$0" <<<"$line"
}

# A managed client owns this loopback bridge across CLI child restarts. Use it
# before deriving a standalone identity or opening direct gateway traffic.
if [ "${STATEWRIGHT_MANAGED_CLIENT_HOST:-claude}" = "claude" ] && [ -n "${STATEWRIGHT_MANAGED_MCP_URL:-}" ]; then
  managed_session_id="${STATEWRIGHT_MANAGED_MCP_SESSION_ID:-}"
  managed_tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/statewright-claude-mcp.XXXXXX")
  trap 'rm -rf "$managed_tmpdir"' EXIT
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    if [ "$method" = "tools/call" ] && run_claude_local_tool "$line"; then
      continue
    fi
    request_headers=(
      -H 'Content-Type: application/json'
    )
    [ -n "$managed_session_id" ] && request_headers+=(-H "Mcp-Session-Id: ${managed_session_id}")
    response_headers="$managed_tmpdir/headers"
    response_body="$managed_tmpdir/body"
    if curl -sS --max-time 15 -D "$response_headers" -o "$response_body" -X POST "${STATEWRIGHT_MANAGED_MCP_URL%/}/mcp" \
      -K <(statewright_bearer_config "${STATEWRIGHT_MANAGED_MCP_BEARER:-}") \
      "${request_headers[@]}" --data-binary "$line" 2>/dev/null; then
      response=$(cat "$response_body")
      response_session_id=$(awk 'BEGIN { IGNORECASE=1 } /^Mcp-Session-Id:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[\r\n]/, ""); print; exit }' "$response_headers")
      [ -n "$response_session_id" ] && managed_session_id="$response_session_id"
    else
      response=""
    fi
    case "$method" in notifications/*) continue ;; esac
    if [ -n "$response" ]; then
      [ "$method" = "tools/list" ] && response=$(inject_claude_local_tools "$response")
      printf '%s\n' "$response"
    else
      env -u STATEWRIGHT_MANAGED_MCP_URL -u STATEWRIGHT_MANAGED_MCP_TOKEN -u STATEWRIGHT_MANAGED_MCP_TOKEN_FILE "$0" <<<"$line"
    fi
  done
  exit 0
fi

if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    if [ "$method" = "tools/call" ] && run_claude_local_tool "$line"; then
      continue
    fi
    response=$(curl -sf --max-time 15 -X POST "${STATEWRIGHT_ADAPTER_URL%/}/mcp" \
      -H 'Content-Type: application/json' \
      -K <(statewright_bearer_config "${STATEWRIGHT_ADAPTER_TOKEN:-}") \
      --data-binary "$line" 2>/dev/null || true)
    case "$method" in notifications/*) continue ;; esac
    if [ -n "$response" ]; then
      [ "$method" = "tools/list" ] && response=$(inject_claude_local_tools "$response")
      printf '%s\n' "$response"
    else
      id=$(printf '%s' "$line" | jq -c '.id // null' 2>/dev/null || echo null)
      printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Statewright executor bridge unavailable."},"id":%s}\n' "$id"
    fi
  done
  exit 0
fi

CLIENT_ID=$(statewright_client_id)
SESSION_HEADER_ARGS=(-H "X-Statewright-Client-Id: ${CLIENT_ID}")
if [ -n "${STATEWRIGHT_MCP_SESSION_ID:-}" ]; then
  SESSION_HEADER_ARGS+=(-H "Mcp-Session-Id: ${STATEWRIGHT_MCP_SESSION_ID}")
fi

# --- Tool discovery (defined before main loop) ---
# A palette endpoint rejection is not evidence that the MCP gateway rejects
# this credential (OAuth audiences can intentionally differ). Keep it local to
# this endpoint and credential; never poison the gateway recovery sentinel.
client_tools_rejection_matches() {
  local marker="${INVALID_KEY_SENTINEL}.client_tools"
  [ -f "$marker" ] &&
    [ "$(cat "$marker" 2>/dev/null)" = "$(key_fingerprint "$PB_URL|$1")" ]
}

mark_client_tools_rejected() {
  local marker="${INVALID_KEY_SENTINEL}.client_tools"
  mkdir -p "$(dirname "$marker")" 2>/dev/null || return 0
  (umask 077; printf '%s\n' "$(key_fingerprint "$PB_URL|$1")" > "$marker")
}

# --- Client tool discovery helpers (no eval; names and values are data) ---
# MCP server names become jq --arg data and argv words, so only plain names
# are scanned.
statewright_safe_server_name() {
  case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  return 0
}

# Discovery only scans plugins the user enabled in Claude (enabledPlugins in
# ~/.claude/settings.json), never every cached marketplace plugin, and only the
# version Claude has installed (an installPath in
# ~/.claude/plugins/installed_plugins.json), never a stale cached version.
# $1 = ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json
statewright_enabled_plugin_config() {
  local rel="${1#"$HOME/.claude/plugins/cache/"}" marketplace plugin dir
  marketplace="${rel%%/*}"; rel="${rel#*/}"; plugin="${rel%%/*}"
  [ -n "$marketplace" ] && [ -n "$plugin" ] || return 1
  jq -e --arg id "$plugin@$marketplace" '.enabledPlugins[$id] == true' "$HOME/.claude/settings.json" >/dev/null 2>&1 || return 1
  dir=$(dirname "$1")
  jq -e --arg id "$plugin@$marketplace" --arg dir "$dir" '
    [.plugins[$id]? | if type == "array" then .[] else . end
      | objects | .installPath | strings | sub("/+$"; "")] | index($dir) != null' \
    "$HOME/.claude/plugins/installed_plugins.json" >/dev/null 2>&1
}

# One curl config line `NAME = "VALUE"`, refusing CR/LF like
# statewright_bearer_config so a value cannot add curl options.
statewright_curl_config_line() {
  local name="$1" value="$2"
  case "$value" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s = "%s"\n' "$name" "$value"
}

# POST tools/list to one HTTP MCP server. The URL and any Authorization
# header travel in a curl config on stdin, never in argv or through eval.
statewright_scan_http_server() {
  local url="$1" auth="$2" config line
  case "$url" in http://*|https://*) ;; *) return 1 ;; esac
  config=$(statewright_curl_config_line url "$url") || return 1
  if [ -n "$auth" ]; then
    case "$auth" in
      [Bb]earer\ *) line=$(statewright_bearer_config "${auth#* }") || return 1 ;;
      *) line=$(statewright_curl_config_line header "Authorization: $auth") || return 1 ;;
    esac
    config="$config"$'\n'"$line"
  fi
  printf '%s\n' "$config" | curl -K - --globoff -sf --max-time 5 -X POST \
    -H 'Content-Type: application/json' \
    --data-raw '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":99}' 2>/dev/null
}

# Discovery runs third-party servers under a hard bound that a server cannot
# shadow: GNU timeout (TERM, then KILL 2s later) or, where there is none
# (macOS), perl's alarm doing the same to the server's process group. Either
# way the group is KILLed once the server exits, so a grandchild cannot keep
# discovery waiting. Both are resolved by absolute path, never through PATH (a
# plugin's env may set PATH).
statewright_scan_bound() {
  local candidate
  for candidate in /usr/bin/timeout /bin/timeout /opt/homebrew/bin/gtimeout /usr/local/bin/gtimeout; do
    [ -x "$candidate" ] && { printf 'timeout\t%s' "$candidate"; return 0; }
  done
  for candidate in /usr/bin/perl /bin/perl; do
    [ -x "$candidate" ] && { printf 'perl\t%s' "$candidate"; return 0; }
  done
  return 1
}

# Launch one stdio MCP server, handshake and list its tools. It runs in a
# subshell with a scrubbed environment: only the inherited variables in `keep`
# survive (STATEWRIGHT_API_KEY, STATEWRIGHT_MANAGED_MCP_TOKEN, *_FILE paths,
# GH_TOKEN and the rest are unset) and the entry's own env is exported (never
# STATEWRIGHT_* names), so env values stay out of argv; argv comes from a
# NUL-delimited jq read, never word-split. The server is bounded by
# statewright_scan_bound (15s, then KILL).
# $1 = server entry JSON, $2 = plugin root for ${CLAUDE_PLUGIN_ROOT}.
statewright_scan_stdio_server() {
  local entry="$1" plugin_root="$2"
  (
    local command arg pair name bound bound_kind bound_bin bound_pid
    local -a argv=() pairs=()
    local keep=" HOME PATH USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TMPDIR TERM "
    bound=$(statewright_scan_bound) || exit 1
    bound_kind="${bound%%$'\t'*}"; bound_bin="${bound#*$'\t'}"
    command=$(printf '%s' "$entry" | jq -r '.command | strings' 2>/dev/null) || exit 1
    [ -n "$command" ] || exit 1
    command="${command//\$\{CLAUDE_PLUGIN_ROOT\}/$plugin_root}"
    while IFS= read -r -d '' arg; do
      argv+=("${arg//\$\{CLAUDE_PLUGIN_ROOT\}/$plugin_root}")
    done < <(printf '%s' "$entry" | jq -j '(.args // []) | if type == "array" then .[] | strings | (. + "\u0000") else empty end' 2>/dev/null)
    while IFS= read -r -d '' pair; do
      name="${pair%%=*}"
      case "$name" in ''|[0-9]*|*[!A-Za-z0-9_]*|STATEWRIGHT_*) continue ;; esac
      pairs+=("$pair")
    done < <(printf '%s' "$entry" | jq -j '(.env // {}) | if type == "object" then to_entries[] | select(.value | type == "string") | (.key + "=" + .value + "\u0000") else empty end' 2>/dev/null)
    while IFS= read -r name; do
      case "$keep" in *" $name "*) continue ;; esac
      unset "$name" 2>/dev/null || export -n "$name" 2>/dev/null || exit 1
    done < <(compgen -e)
    for pair in ${pairs[@]+"${pairs[@]}"}; do export "$pair"; done
    export CLAUDE_PLUGIN_ROOT="$plugin_root"
    {
      printf '%s\n' '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"statewright-scanner","version":"0.1"}},"id":1}'
      sleep 0.5
      printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
      sleep 2
    } | if [ "$bound_kind" = timeout ]; then
      # timeout leads its own process group; once it returns, KILL whatever
      # the server left in that group so a grandchild cannot hold stdout open.
      "$bound_bin" -k 2 15 "$command" ${argv[@]+"${argv[@]}"} <&0 2>/dev/null &
      bound_pid=$!
      wait "$bound_pid"
      kill -KILL -- "-$bound_pid" 2>/dev/null
    else
      "$bound_bin" -e '
        my $t = shift; my $p = fork; exit 1 unless defined $p;
        if (!$p) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127 }
        $SIG{ALRM} = sub { kill "TERM", -$p; sleep 2; kill "KILL", -$p; waitpid($p, 0); exit 124 };
        alarm $t; waitpid($p, 0); my $status = $? >> 8; kill "KILL", -$p; exit $status' 15 "$command" ${argv[@]+"${argv[@]}"} 2>/dev/null
    fi
  )
}

upload_client_tools() {
  local key="$1"
  client_tools_rejection_matches "$key" && return 0
  local MCP_CONFIG="$HOME/.claude/.mcp.json"
  local tools

  # Claude Code built-in tools + statewright MCP tools (can't self-scan)
  tools=$(jq -n '[
    {"name":"Read","source":"Claude Code","category":"File"},
    {"name":"Edit","source":"Claude Code","category":"File"},
    {"name":"Write","source":"Claude Code","category":"File"},
    {"name":"MultiEdit","source":"Claude Code","category":"File"},
    {"name":"Glob","source":"Claude Code","category":"File"},
    {"name":"Grep","source":"Claude Code","category":"File"},
    {"name":"LS","source":"Claude Code","category":"File"},
    {"name":"Bash","source":"Claude Code","category":"Execute"},
    {"name":"Agent","source":"Claude Code","category":"Execute"},
    {"name":"WebFetch","source":"Claude Code","category":"Web"},
    {"name":"WebSearch","source":"Claude Code","category":"Web"},
    {"name":"NotebookEdit","source":"Claude Code","category":"Notebook"},
    {"name":"statewright_start","source":"MCP:statewright","category":"MCP","description":"Activate a workflow for this session"},
    {"name":"statewright_stop","source":"MCP:statewright","category":"MCP","description":"Deactivate the current workflow"},
    {"name":"statewright_transition","source":"MCP:statewright","category":"MCP","description":"Transition to the next state"},
    {"name":"statewright_get_state","source":"MCP:statewright","category":"MCP","description":"Get current state, allowed tools, and transitions"},
    {"name":"statewright_list_workflows","source":"MCP:statewright","category":"MCP","description":"List available workflows"}
  ]')

  # Scan the user's own MCP config and enabled Claude plugins for more tools.
  # Server names, URLs, headers, args and env are data: no eval, no jq
  # program interpolation, no `bash -c` strings.
  local -a mcp_configs=()
  [ -f "$MCP_CONFIG" ] && mcp_configs+=("$MCP_CONFIG")
  local pconf
  for pconf in "$HOME/.claude/plugins/cache"/*/*/*/.mcp.json; do
    [ -f "$pconf" ] && statewright_enabled_plugin_config "$pconf" && mcp_configs+=("$pconf")
  done
  local disabled_servers
  disabled_servers=$(jq -c '.disabledMcpjsonServers // [] | if type == "array" then map(strings) else [] end' "$HOME/.claude/settings.json" 2>/dev/null || true)
  [ -n "$disabled_servers" ] || disabled_servers='[]'

  local seen_servers="" conf_file server entry server_url server_tools plugin_root
  for conf_file in ${mcp_configs[@]+"${mcp_configs[@]}"}; do
    plugin_root=$(dirname "$conf_file")
    while IFS= read -r server; do
      statewright_safe_server_name "$server" || continue
      [ "$server" = "statewright" ] && continue
      # Skip duplicates across config files
      case " $seen_servers " in *" $server "*) continue ;; esac
      seen_servers="$seen_servers $server"
      entry=$(jq -c --arg s "$server" --argjson disabled "$disabled_servers" \
        '.mcpServers[$s] | select(type == "object") | select(.disabled != true) | select(($disabled | index($s)) == null)' \
        "$conf_file" 2>/dev/null || true)
      [ -n "$entry" ] || continue
      server_url=$(printf '%s' "$entry" | jq -r '.url // empty | strings' 2>/dev/null || true)
      server_tools=""

      if [ -n "$server_url" ]; then
        # HTTP MCP server — single POST
        server_tools=$(statewright_scan_http_server "$server_url" \
          "$(printf '%s' "$entry" | jq -r '.headers.Authorization // empty | strings' 2>/dev/null || true)" \
          | jq -c --arg server "$server" '[.result.tools[]? | {name: .name, source: ("MCP:" + $server), category: "MCP", description: .description}]' 2>/dev/null)
      elif [ -n "$(printf '%s' "$entry" | jq -r '.command // empty | strings' 2>/dev/null || true)" ]; then
        # Stdio MCP server — launch, handshake, query, kill
        server_tools=$(statewright_scan_stdio_server "$entry" "$plugin_root" \
          | LC_ALL=C LANG=C perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' \
          | jq -s -c --arg server "$server" '[.[] | select(.id == 2) | .result.tools[]? | {name: .name, source: ("MCP:" + $server), category: "MCP", description: (.description // "")[:120]}]' 2>/dev/null)
      fi

      if [ -n "$server_tools" ] && [ "$server_tools" != "null" ] && [ "$server_tools" != "[]" ]; then
        tools=$(printf '%s' "$tools" | jq -c --argjson more "$server_tools" '. + $more' 2>/dev/null || printf '%s' "$tools")
      fi
    done < <(jq -r '.mcpServers // {} | if type == "object" then keys[] else empty end' "$conf_file" 2>/dev/null)
  done

  # Discover Taskfile/Makefile commands, namespaced by directory basename
  local commands='[]'
  local project_name=$(basename "$(pwd)")
  if command -v task &>/dev/null && { [ -f "Taskfile.yml" ] || [ -f "Taskfile.yaml" ] || [ -f "taskfile.yml" ]; }; then
    local task_cmds=$(task --list-all 2>/dev/null | grep '^\*' | awk '{print $2}' | sed 's/:$//' | head -30)
    if [ -n "$task_cmds" ]; then
      commands=$(echo "$task_cmds" | jq -R '.' | jq -s --arg proj "$project_name" '[.[] | {name: ., source: "Taskfile", category: "task", project: $proj}]')
    fi
  fi
  if [ -f "Makefile" ] || [ -f "makefile" ]; then
    local make_cmds=$(make -pRrq 2>/dev/null | awk -F: '/^[a-zA-Z0-9][^$#\/\t=]*:([^=]|$)/ {split($1,a," ");print a[1]}' | sort -u | grep -v '^\.' | head -30)
    if [ -n "$make_cmds" ]; then
      local make_json=$(echo "$make_cmds" | jq -R '.' | jq -s --arg proj "$project_name" '[.[] | {name: ., source: "Makefile", category: "make", project: $proj}]')
      commands=$(printf '%s' "$commands" | jq -c --argjson more "$make_json" '. + $more' 2>/dev/null || printf '%s' "$commands")
    fi
  fi

  # Upload tools + commands to PB
  local response status body
  body=$(mktemp "${TMPDIR:-/tmp}/statewright-client-tools.XXXXXX") || return 0
  status=$(curl -sS --max-time 10 -o "$body" -w '%{http_code}' -X POST "$PB_URL/api/client-tools" \
    -H 'Content-Type: application/json' \
    -K <(statewright_bearer_config "$key") \
    -d "{\"tools\": $tools, \"commands\": $commands}" 2>/dev/null || true)
  response=$(cat "$body" 2>/dev/null || true)
  rm -f "$body"
  if [ "$status" = "401" ] && printf '%s' "$response" | jq -e '.error == "invalid_api_key"' >/dev/null 2>&1; then
    mark_client_tools_rejected "$key"
  fi
}

# --- Main proxy loop ---
while IFS= read -r line; do
  [ -z "$line" ] && continue

  API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$KEY_FILE" 2>/dev/null || true)}"
  API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"  # trim trailing whitespace/newlines
  METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
  TOOL_NAME=$(echo "$line" | jq -r '.params.name // empty' 2>/dev/null)
  # Public documentation search uses only the published index, not the gateway.
  PUBLIC_DOCS_CALL=false
  if [ "$METHOD" = "tools/call" ] && [ "$TOOL_NAME" = "statewright_search_docs" ]; then
    PUBLIC_DOCS_CALL=true
  fi

  if [ -n "$API_KEY" ] && ! invalid_key_matches "$API_KEY"; then
    rm -f "$INVALID_KEY_SENTINEL" "$MISSING_KEY_SENTINEL"
  fi

  if [ "$PUBLIC_DOCS_CALL" != true ] && [ -n "$API_KEY" ] && invalid_key_matches "$API_KEY"; then
    if [ "$METHOD" != "notifications/initialized" ]; then
      echo '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key is invalid or revoked. Visit https://statewright.ai/keys to generate a new key, then restart this client."},"id":'"$(echo "$line" | jq -r '.id // null' 2>/dev/null)"'}'
    fi
    continue
  fi

  if [ "$PUBLIC_DOCS_CALL" != true ] && [ -z "$API_KEY" ]; then
    METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    [ "$METHOD" = "notifications/initialized" ] || prompt_missing_key

    if [ "$METHOD" = "initialize" ]; then
      echo '{"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"statewright","version":"0.1.0"}},"id":'"$ID"'}'
    elif [ "$METHOD" = "tools/list" ]; then
      echo '{"jsonrpc":"2.0","result":{"tools":[{"name":"statewright_start","description":"Activate a statewright workflow for this session. Tools will be restricted per state.","inputSchema":{"type":"object","properties":{"workflow":{"type":"string","description":"Exact enabled workflow name returned by statewright_list_workflows"}},"required":["workflow"]}},{"name":"statewright_stop","description":"Deactivate the current workflow. All tools become available again.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_state","description":"Get the current workflow state, allowed tools, and available transitions.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_transition","description":"Transition to the next state in the workflow.","inputSchema":{"type":"object","properties":{"event":{"type":"string","description":"Transition event name (e.g. READY, DONE, PASS, FAIL)"}},"required":["event"]}},{"name":"statewright_list_workflows","description":"List all available workflows for this user.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (e.g. guard operators, allowed_tools, approval gate)"}},"required":["query"]}},{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_status","description":"Get gateway status: active workflow, current state, available workflows.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true in the workflow.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}]},"id":'"$ID"'}'
    elif [ "$METHOD" = "notifications/initialized" ]; then
      : # notification, no response
    else
      echo '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key not configured. Visit https://statewright.ai/keys to generate one."},"id":'"$ID"'}'
    fi
    continue
  fi

  # Notifications: no response needed, trigger side effects
  if [ "$METHOD" = "notifications/initialized" ]; then
    if [ -n "$API_KEY" ]; then
      (upload_client_tools "$API_KEY" &)
    fi
    continue
  fi

  # Handle statewright_search_docs locally (no gateway round-trip)
  if [ "$METHOD" = "tools/call" ] && [ "$TOOL_NAME" = "statewright_search_docs" ]; then
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    QUERY=$(echo "$line" | jq -r '.params.arguments.query // empty' 2>/dev/null)
    if [ -z "$QUERY" ]; then
      echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Missing required parameter: query"}]},"id":'"$ID"'}'
    else
      # Fetch search index and do keyword matching
      INDEX=$(curl -sf --max-time 5 "https://docs.statewright.ai/search-index.json" 2>/dev/null)
      if [ -n "$INDEX" ]; then
        RESULTS=$(echo "$INDEX" | jq --arg q "$QUERY" '
          ($q | ascii_downcase | split(" ")) as $terms |
          [.[] | . as $chunk |
            ($chunk.title | ascii_downcase) as $t |
            ($chunk.section | ascii_downcase) as $s |
            ($chunk.content | ascii_downcase) as $c |
            ([$terms[] | select(($t | contains(.)) or ($s | contains(.)))] | length) as $title_hits |
            ([$terms[] | select($c | contains(.))] | length) as $content_hits |
            select(($title_hits + $content_hits) > 0) |
            {url, title, section, content: $chunk.content, score: (($title_hits * 3) + $content_hits)}
          ] | sort_by(-.score) | unique_by(.url + .section) | .[0:5] |
          [.[] | {url, title, section, snippet: .content[0:500]}]
        ' 2>/dev/null)
        # Always include the full schema if query mentions schema/definition/create
        if echo "$QUERY" | grep -qiE 'schema|definition|create workflow'; then
          SCHEMA_CHUNK=$(echo "$INDEX" | jq -c '[.[] | select(.title == "Workflow JSON Schema")] | .[0] // empty' 2>/dev/null)
          if [ -n "$SCHEMA_CHUNK" ] && [ "$SCHEMA_CHUNK" != "null" ]; then
            SCHEMA_ENTRY=$(echo "$SCHEMA_CHUNK" | jq -c '{url, title, section, snippet: .content}')
            RESULTS=$(echo "$RESULTS" | jq --argjson s "$SCHEMA_ENTRY" '. | if any(.title == "Workflow JSON Schema") then . else [$s] + .[0:4] end')
          fi
        fi
        if [ -n "$RESULTS" ] && [ "$RESULTS" != "[]" ]; then
          RESULT_TEXT=$(echo "$RESULTS" | jq -r '
            def canonical_doc_url:
              if . == "/workflow-schema.json" then "https://statewright.ai/workflow-schema.json"
              elif type == "string" and test("^/docs/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$")
                then "https://docs.statewright.ai/" + ltrimstr("/docs/") + "/"
              else empty end;
            .[] | (.url | canonical_doc_url) as $url |
            "## \(.title) > \(.section)\nURL: \($url)\n\(.snippet)\n"
          ' 2>/dev/null)
          if [ -n "$RESULT_TEXT" ]; then
            jq -cn --arg text "$RESULT_TEXT" '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":$text}]},"id":'"$ID"'}'
          else
            jq -cn --arg text "No results found for: $QUERY" '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":$text}]},"id":'"$ID"'}'
          fi
        else
          echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"No results found for: '"$QUERY"'"}]},"id":'"$ID"'}'
        fi
      else
        echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Search index unavailable"}]},"id":'"$ID"'}'
      fi
    fi
    continue
  fi

  # Forward to gateway with auth
  RESPONSE=$(curl -sf --max-time 10 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -K <(statewright_bearer_config "$API_KEY") \
    "${SESSION_HEADER_ARGS[@]}" \
    -d "$line" 2>/dev/null)

  if [ -n "$RESPONSE" ]; then
    # Inject local tools into tools/list responses from gateway
    if [ "$METHOD" = "tools/list" ]; then
      SEARCH_TOOL='{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting. Returns relevant doc snippets.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (e.g. guard operators, allowed_tools, approval gate)"}},"required":["query"]}}'
      PAUSE_TOOL='{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}}'
      FORCE_TOOL='{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}'
      RESPONSE=$(echo "$RESPONSE" | jq -c --argjson s "$SEARCH_TOOL" --argjson p "$PAUSE_TOOL" --argjson f "$FORCE_TOOL" '.result.tools = ([.result.tools[] | select(.name != "statewright_search_docs" and .name != "statewright_pause" and .name != "statewright_force_state")] + [$s, $p, $f])' 2>/dev/null || echo "$RESPONSE")
    fi
    echo "$RESPONSE"
  else
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    echo '{"jsonrpc":"2.0","error":{"code":-2,"message":"Gateway unreachable"},"id":'"$ID"'}'
  fi

done
