# Source this file from Bash or Zsh. These selectors use the installed Claude
# command on PATH; they do not install a runtime or manage credentials.
unalias claude sclaude d1claude d2claude d3claude 2>/dev/null || :

_statewright_claude_environment() (
  # A new invocation must not reuse the caller's gateway or managed session.
  # A subshell keeps the caller's environment intact, including on failure.
  unset STATEWRIGHT_GATEWAY_URL STATEWRIGHT_PB_URL STATEWRIGHT_API_KEY \
    STATEWRIGHT_DOCS_URL STATEWRIGHT_CLIENT_ID STATEWRIGHT_MCP_SESSION_ID \
    STATEWRIGHT_ROUTE_CONTROL_DIR STATEWRIGHT_MANAGED_CLIENT_HOST \
    STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID \
    STATEWRIGHT_MANAGED_MCP_URL STATEWRIGHT_MANAGED_MCP_SESSION_ID \
    STATEWRIGHT_MANAGED_MCP_TOKEN STATEWRIGHT_MANAGED_TELEMETRY_OWNER \
    STATEWRIGHT_ADAPTER_URL STATEWRIGHT_ADAPTER_TOKEN || exit 2
  STATEWRIGHT_ENV="$1"
  export STATEWRIGHT_ENV
  shift
  command claude "$@"
)

claude()   { _statewright_claude_environment "" "$@"; }
sclaude()  { _statewright_claude_environment staging "$@"; }
d1claude() { _statewright_claude_environment dev1 "$@"; }
d2claude() { _statewright_claude_environment dev2 "$@"; }
d3claude() { _statewright_claude_environment dev3 "$@"; }
