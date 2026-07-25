#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../tool-policy.sh
source "$ROOT/tool-policy.sh"

assert_allowed() {
  STATEWRIGHT_ALLOWED_TOOLS="$1"
  if ! statewright_tool_allowed "$2" "$3"; then
    echo "expected allow: $2" >&2
    exit 1
  fi
}

assert_denied() {
  STATEWRIGHT_ALLOWED_TOOLS="$1"
  if statewright_tool_allowed "$2" "$3"; then
    echo "expected denial: $2" >&2
    exit 1
  fi
}

shell_input() { jq -n --arg command "$1" '{tool_input:{command:$command}}'; }

assert_allowed "Read" Bash "$(shell_input 'sed -n "1,12p" README.md')"
assert_allowed "Grep" exec_command "$(shell_input "rg -n 'needle' src")"
assert_allowed "Glob" Bash "$(shell_input "find src -name '*.rs'")"
assert_denied "Read" Bash "$(shell_input 'printf x > marker.txt')"
if ! statewright_has_file_write_redirect 'cat missing 2> errors.txt'; then
  echo "expected stderr redirect to be a file write" >&2
  exit 1
fi
if statewright_has_file_write_redirect 'cat missing 2>/dev/null'; then
  echo "expected /dev/null redirect to remain read-only" >&2
  exit 1
fi
assert_denied "Read" Bash "$(shell_input 'python3 -c "print(1)"')"
assert_denied "Read" Bash "$(shell_input 'git stash')"
assert_allowed "Edit" apply_patch '{}'
assert_allowed "WebSearch" webrun '{"tool_input":{"search_query":[{"q":"Statewright"}]}}'
assert_allowed "WebFetch" webrun '{"tool_input":{"open":[{"ref_id":"x"}]}}'
assert_allowed "ImageGen" image_genimagegen '{}'

echo "tool policy tests passed"
