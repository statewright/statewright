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
cmd_input() { jq -n --arg command "$1" '{tool_input:{cmd:$command}}'; }
zsh_input() { jq -n --arg command "$1" '{tool_input:{command:$command,shell:"/bin/zsh"}}'; }

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

assert_allowed "Read" Bash "$(shell_input 'cat README.md')"
assert_allowed "Read" exec_command "$(shell_input "rg -n 'needle' src")"
assert_allowed "Read" Bash "$(shell_input "find src -name '*.rs'")"
assert_allowed "Read" exec_command "$(cmd_input "rg -n 'needle' src")"
for command in 'cat README.md' 'cat README.md && cat LICENSE' "rg -n 'needle' src" "find src -name '*.rs'"; do
  assert_allowed $'Read\nBash' exec_command "$(shell_input "$command")"
  test "$STATEWRIGHT_TOOL_MODE" = "readonly_shell"
done
assert_allowed $'Read\nBash' exec_command "$(shell_input 'task test:unit')"
test "$STATEWRIGHT_TOOL_MODE" = "bash"
for native in Read read_file Grep grep search_files Glob glob find find_files ls list_directory; do
  assert_allowed "Read" "$native" '{}'
done
assert_denied "Read" Bash '{}'
assert_denied "Read" Bash "$(shell_input 'printf x > marker.txt')"
assert_denied "Read" Bash "$(shell_input 'sed -n "1,12p" README.md')"
assert_denied "Read" Bash "$(shell_input 'git branch feature')"
assert_denied "Read" Bash "$(shell_input 'git tag v1')"
assert_denied "Read" Bash "$(shell_input 'rg --pre /bin/cat needle README.md')"
assert_denied "Read" Bash "$(shell_input 'ripgrep --pre=/bin/cat needle README.md')"
assert_denied "Read" Bash "$(shell_input $'rg\t--pre\t/bin/cat needle README.md')"
assert_denied "Read" Bash "$(shell_input "rg '--pre' /bin/cat needle README.md")"
assert_denied "Read" Bash "$(shell_input 'rg --p""re /bin/cat needle README.md')"
assert_denied "Read" Bash "$(shell_input "find . '-exec' touch marker \\;")"
assert_denied "Read" Bash "$(shell_input 'find . -e""xec /bin/echo {} +')"
assert_denied "Read" Bash "$(shell_input $'find .\t-exec\ttouch marker \\;')"
assert_denied "Read" Bash "$(shell_input 'find . -fprintf result.txt %p')"
assert_denied "Read" Bash "$(shell_input 'fd -x touch marker')"
assert_denied "Read" Bash "$(shell_input "fd '--exec' touch marker")"
assert_denied "Read" Bash "$(shell_input 'fd -X touch marker')"
assert_denied "Read" Bash "$(shell_input 'fd -HIx echo {}')"
assert_denied "Bash" exec_command "$(zsh_input 'rg -n needle README.md')"
assert_allowed "Read" Read '{"tool_input":{"shell":"/bin/zsh"}}'
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
for command in \
  'sha256sum receipt.json' \
  'sha256sum -- receipt.json ./second.json' \
  'sha256sum "path with spaces/receipt.json"' \
  "sha256sum 'path with spaces/receipt.json'" \
  '/usr/bin/shasum -a 256 /tmp/receipt.json' \
  'shasum -a 256 -- receipt.json ./second.json' \
  'shasum -a 256 receipt.json | head -n 1'; do
  for tool in Bash exec_command; do
    assert_allowed "Read" "$tool" "$(shell_input "$command")"
    test "$STATEWRIGHT_TOOL_MODE" = "readonly_shell"
    assert_denied "Grep" "$tool" "$(shell_input "$command")"
    assert_denied "Glob" "$tool" "$(shell_input "$command")"
  done
done
for command in \
  'sha256sum' 'sha256sum -' 'sha256sum --' \
  'sha256sum --check receipt.sha256' 'sha256sum -c receipt.sha256' \
  'sha256sum --binary receipt.json' 'sha256sum receipt.json --help' \
  'shasum receipt.json' 'shasum -a 512 receipt.json' 'shasum -a 256' \
  'shasum -a 256 --check receipt.sha256' \
  'sha256sum receipt.json > receipt.sha256' \
  'sha256sum receipt.json; touch marker' \
  'sha256sum receipt.json & touch marker' \
  'sha256sum $(touch marker)' 'sha256sum `touch marker`' \
  'sha256sum "$RECEIPT"' 'sha256sum *.json' \
  'sha256sum "unterminated' \
  'openssl dgst -sha256 receipt.json' \
  'python3 -c "print(1)"'; do
  assert_denied "Read" exec_command "$(shell_input "$command")"
done
assert_denied "Read" Bash "$(shell_input 'git stash')"
assert_allowed "Write" apply_patch '{}'
assert_allowed "Write" Edit '{}'
assert_allowed "Write" MultiEdit '{}'
assert_denied "Edit" apply_patch '{}'
assert_allowed "WebSearch" webrun '{"tool_input":{"search_query":[{"q":"Statewright"}]}}'
assert_allowed "WebFetch" webrun '{"tool_input":{"open":[{"ref_id":"x"}]}}'
assert_allowed "ImageGen" image_genimagegen '{}'

echo "tool policy tests passed"
