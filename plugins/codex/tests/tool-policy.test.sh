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

for capability in Bash bash Read Grep Glob; do
  assert_allowed "$capability" write_stdin '{"tool_input":{"session_id":42,"chars":""}}'
  test "$STATEWRIGHT_TOOL_MODE" = "poll"
  assert_allowed "$capability" write_stdin '{"tool_input":{"session_id":42}}'
  test "$STATEWRIGHT_TOOL_MODE" = "poll"
  assert_denied "$capability" write_stdin '{"tool_input":{"session_id":42,"chars":"rm -rf target\n"}}'
  assert_denied "$capability" write_stdin '{"tool_input":{"session_id":42,"chars":"\u0003"}}'
  assert_denied "$capability" write_stdin '{"tool_input":{"session_id":42,"chars":null}}'
done
assert_denied "Write" write_stdin '{"tool_input":{"session_id":42,"chars":""}}'
assert_allowed "write_stdin" write_stdin '{"tool_input":{"session_id":42,"chars":"yes\n"}}'

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
if statewright_has_file_write_redirect "rg '>' src"; then
  echo "expected quoted redirect literal to remain read-only" >&2
  exit 1
fi
if statewright_has_inplace_file_modify "rg 'sed -i' src"; then
  echo "expected quoted in-place literal to remain read-only" >&2
  exit 1
fi
if ! statewright_has_inplace_file_modify "sed -i 's/a/b/' file"; then
  echo "expected sed -i to be treated as an in-place write" >&2
  exit 1
fi
for command in 'tee file' 'dd of=file' 'cp from to' 'mv from to' 'ln from to' 'install from to' 'rsync from to' 'mkdir dir' 'touch file' 'chmod 600 file' 'chown user file'; do
  if ! statewright_has_file_write_primitive "$command"; then
    echo "expected $command to be treated as a file write" >&2
    exit 1
  fi
done
assert_denied "Read" Bash "$(shell_input 'python3 -c "print(1)"')"
assert_denied "Read" Bash "$(shell_input 'git stash')"
assert_allowed "Edit" apply_patch '{}'
assert_allowed "WebSearch" webrun '{"tool_input":{"search_query":[{"q":"Statewright"}]}}'
assert_allowed "WebFetch" webrun '{"tool_input":{"open":[{"ref_id":"x"}]}}'
assert_allowed "ImageGen" image_genimagegen '{}'

echo "tool policy tests passed"
