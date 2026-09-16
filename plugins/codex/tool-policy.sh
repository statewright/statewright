#!/usr/bin/env bash
# Provider compatibility policy. `allowed_tools` names capabilities, while
# Codex may expose a provider-specific concrete tool name.

STATEWRIGHT_TOOL_MODE=""
STATEWRIGHT_ALLOWED_TOOLS=""

statewright_has_capability() {
  local capability="$1"
  printf '%s\n' "$STATEWRIGHT_ALLOWED_TOOLS" | grep -Fqx "$capability"
}

statewright_normalize_tool() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]'
}

statewright_is_shell_tool() {
  case "$1" in
    Bash|bash|exec_command) return 0 ;;
    *) return 1 ;;
  esac
}

# Only checksum generation over explicit file operands, not check manifests,
# stdin, arbitrary options, interpreters, or shell-expanded operands.
statewright_checksum_args_allowed() {
  local executable="$1" args="$2" operand pattern
  operand="([[:alnum:]_./][[:alnum:]_./:@%+=,-]*|'[[:alnum:]_./][[:alnum:]_./:@%+=, -]*'|\"[[:alnum:]_./][[:alnum:]_./:@%+=, -]*\")"
  pattern="^(--[[:blank:]]+)?${operand}([[:blank:]]+${operand})*$"
  if [ "$executable" = "shasum" ]; then
    pattern="^-a[[:blank:]]+256[[:blank:]]+(--[[:blank:]]+)?${operand}([[:blank:]]+${operand})*$"
  fi
  [[ "$args" =~ $pattern ]]
}

statewright_readonly_segment_capability() {
  local segment="$1" token args
  STATEWRIGHT_SEGMENT_CAPABILITY=""

  # Environment assignments, substitutions, and shell escapes are not safe to
  # elevate from a declarative read capability.
  case "$segment" in
    ''|[[:space:]]*|[A-Za-z_][A-Za-z0-9_]*=*) return 1 ;;
  esac

  token=$(printf '%s\n' "$segment" | sed -E 's/^[[:space:]]*([^[:space:]]+).*/\1/')
  token=${token##*/}
  args=$(printf '%s\n' "$segment" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//')

  case "$token" in
    sha256sum|shasum)
      statewright_checksum_args_allowed "$token" "$args" || return 1
      STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
    cat|head|tail|less|more|bat|xxd|ls|pwd|stat|file|wc|du|dirname|basename|realpath|jq|cut|tr|sort|uniq|which|true|false)
      STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
    grep|rg|ag|ack|ripgrep)
      STATEWRIGHT_SEGMENT_CAPABILITY="Grep" ;;
    find|fd|locate|mdfind)
      case " $args " in
        *' -delete '*|*' -exec '*|*' -execdir '*|*' -ok '*|*' -okdir '*|*' -fls '*|*' -fprint '*|*' -fprint0 '*) return 1 ;;
      esac
      STATEWRIGHT_SEGMENT_CAPABILITY="Glob" ;;
    sed)
      case "$args" in
        -n\ *|--quiet\ *) STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
        *) return 1 ;;
      esac ;;
    git)
      case "$args" in
        status*|diff*|log*|show*|rev-parse*|ls-files*|grep*|describe*|branch\ --show-current*|branch\ --list*)
          STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
        *) return 1 ;;
      esac ;;
    command)
      case "$args" in
        -v\ *) STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

statewright_readonly_shell_allowed() {
  local command="$1" normalized segment

  # Permit only output-discard redirects. Everything else that changes shell
  # evaluation or can write a file remains an explicit-Bash operation.
  normalized=$(printf '%s' "$command" | sed -E \
    -e 's/(^|[[:space:]])[012]?>[[:space:]]*\/dev\/null([[:space:]]|$)/ /g' \
    -e 's/(^|[[:space:]])2>&1([[:space:]]|$)/ /g')
  case "$normalized" in
    ''|*$'\n'*|*$'\r'*|*'<'*|*'>'*|*'`'*|*'$('* ) return 1 ;;
  esac

  while IFS= read -r segment; do
    segment=$(printf '%s\n' "$segment" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
    [ -z "$segment" ] && continue
    statewright_readonly_segment_capability "$segment" || return 1
    statewright_has_capability "$STATEWRIGHT_SEGMENT_CAPABILITY" || return 1
  done <<EOF
$(printf '%s\n' "$normalized" | sed -E 's/&&|\|\||[;|]/\n/g')
EOF
}

statewright_has_file_write_redirect() {
  local command="$1" normalized
  normalized=$(statewright_unquoted_shell "$command" | sed -E \
    -e 's/(^|[[:space:]])[012]?>[[:space:]]*\/dev\/null([[:space:]]|$)/ /g' \
    -e 's/(^|[[:space:]])2>&1([[:space:]]|$)/ /g')
  case "$normalized" in
    *'>'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Remove quoted shell literals before looking for executable operations. This
# avoids denying read-only searches such as `rg 'sed -i'`.
statewright_unquoted_shell() {
  local input="$1" output="" quote="" char index=0
  while [ "$index" -lt "${#input}" ]; do
    char="${input:$index:1}"
    if [ -n "$quote" ]; then
      if [ "$char" = "$quote" ]; then quote=""; fi
      index=$((index + 1))
      continue
    fi
    case "$char" in
      "'"|'"') quote="$char" ;;
      '\\') index=$((index + 1)) ;;
      *) output+="$char" ;;
    esac
    index=$((index + 1))
  done
  printf '%s' "$output"
}

statewright_has_inplace_file_modify() {
  local normalized
  normalized=$(statewright_unquoted_shell "$1")
  printf '%s\n' "$normalized" | grep -qE '(^|[[:space:];|&])(sed[[:space:]]+-[^[:space:]]*i|perl[[:space:]]+-p?i)([[:space:]]|$)'
}

statewright_has_file_write_primitive() {
  local normalized
  normalized=$(statewright_unquoted_shell "$1")
  printf '%s\n' "$normalized" | grep -qE '(^|[[:space:];|&])(tee|dd|cp|mv|ln|install|rsync|mkdir|touch|chmod|chown)([[:space:]]|$)'
}

statewright_web_allowed() {
  local input="$1" required
  required=$(printf '%s' "$input" | jq -r '
    .tool_input // {} |
    [
      (if has("search_query") or has("image_query") then "WebSearch" else empty end),
      (if has("open") or has("click") or has("find") or has("screenshot") or has("finance") or has("weather") or has("sports") or has("time") then "WebFetch" else empty end)
    ] | .[]' 2>/dev/null || true)
  [ -n "$required" ] || return 1
  while IFS= read -r capability; do
    statewright_has_capability "$capability" || return 1
  done <<< "$required"
}

statewright_tool_allowed() {
  local tool_name="$1" hook_input="$2" normalized command
  STATEWRIGHT_TOOL_MODE=""

  # Poll an existing native command without admitting arbitrary stdin writes.
  # Interactive input requires an explicit write_stdin capability.
  if [ "$tool_name" = "write_stdin" ] && ! statewright_has_capability "write_stdin"; then
    if printf '%s' "$hook_input" | jq -e '.tool_input | (has("chars") | not) or .chars == ""' >/dev/null 2>&1; then
      if statewright_has_capability "Bash" || statewright_has_capability "bash" || statewright_has_capability "Read" ||
         statewright_has_capability "Grep" || statewright_has_capability "Glob"; then
        STATEWRIGHT_TOOL_MODE="poll"
        return 0
      fi
    fi
    return 1
  fi

  # Shell tools must reach Bash discernment even when Bash itself is allowed.
  # Checking the raw tool name first would let redirects and in-place edits
  # bypass the state policy.
  if statewright_is_shell_tool "$tool_name"; then
    command=$(printf '%s' "$hook_input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if statewright_has_capability "Bash" || statewright_has_capability "exec_command"; then
      STATEWRIGHT_TOOL_MODE="bash"
      return 0
    fi
    if [ -n "$command" ] && statewright_readonly_shell_allowed "$command"; then
      STATEWRIGHT_TOOL_MODE="readonly_shell"
      return 0
    fi
    return 1
  fi

  statewright_has_capability "$tool_name" && { STATEWRIGHT_TOOL_MODE="direct"; return 0; }

  case "$tool_name" in
    apply_patch|edit_file|write_file|create_or_update_file)
      if statewright_has_capability "Edit" || statewright_has_capability "Write"; then
        STATEWRIGHT_TOOL_MODE="edit"
        return 0
      fi ;;
    view_image)
      if statewright_has_capability "Read"; then
        STATEWRIGHT_TOOL_MODE="read"
        return 0
      fi ;;
  esac

  normalized=$(statewright_normalize_tool "$tool_name")
  case "$normalized" in
    webrun)
      statewright_web_allowed "$hook_input" && { STATEWRIGHT_TOOL_MODE="web"; return 0; } ;;
    imagegenimagegen|imagegen)
      if statewright_has_capability "ImageGen"; then
        STATEWRIGHT_TOOL_MODE="image"
        return 0
      fi ;;
  esac

  return 1
}
