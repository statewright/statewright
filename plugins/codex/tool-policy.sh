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
    Bash|bash|exec_command|run_command|shell|Zsh|zsh) return 0 ;;
    *) return 1 ;;
  esac
}

statewright_uses_unsupported_shell() {
  local tool_name="$1" hook_input="$2" shell
  case "$tool_name" in
    Bash|bash|exec_command|run_command|shell|Zsh|zsh) ;;
    *) return 1 ;;
  esac
  [ "$tool_name" = "Zsh" ] || [ "$tool_name" = "zsh" ] && return 0
  shell=$(printf '%s' "$hook_input" | jq -r '.tool_input.shell // empty' 2>/dev/null || true)
  shell=${shell%%[[:space:]]*}
  shell=${shell##*/}
  [ "$shell" = "zsh" ]
}

statewright_input_command() {
  printf '%s' "$1" | jq -r '.tool_input.command // .tool_input.cmd // empty' 2>/dev/null || true
}

# No-eval, deliberately small shell tokenizer for the read-only fallback.
# It recognizes only quoting and backslash escaping; expansion, redirection,
# command separators, and substitutions are rejected before classification.
STATEWRIGHT_TOKENS=()
statewright_readonly_tokens() {
  local input="$1" current="" quote="" char next index=0 started=false
  STATEWRIGHT_TOKENS=()
  while [ "$index" -lt "${#input}" ]; do
    char="${input:$index:1}"
    if [ -n "$quote" ]; then
      if [ "$char" = "$quote" ]; then
        quote=""
        started=true
      elif [ "$quote" = '"' ] && { [ "$char" = '$' ] || [ "$char" = '`' ]; }; then
        return 1
      elif [ "$quote" = '"' ] && [ "$char" = '\\' ]; then
        index=$((index + 1))
        [ "$index" -lt "${#input}" ] || return 1
        current+="${input:$index:1}"
        started=true
      else
        current+="$char"
        started=true
      fi
    else
      case "$char" in
        "'"|'"') quote="$char"; started=true ;;
        '\\')
          index=$((index + 1))
          [ "$index" -lt "${#input}" ] || return 1
          current+="${input:$index:1}"
          started=true ;;
        ' '|$'\t')
          if [ "$started" = true ]; then
            STATEWRIGHT_TOKENS+=("$current")
            current=""
            started=false
          fi ;;
        ';'|'|'|'&'|'>'|'<'|'`'|'$'|$'\n'|$'\r') return 1 ;;
        *) current+="$char"; started=true ;;
      esac
    fi
    index=$((index + 1))
  done
  [ -z "$quote" ] || return 1
  [ "$started" = true ] && STATEWRIGHT_TOKENS+=("$current")
  [ "${#STATEWRIGHT_TOKENS[@]}" -gt 0 ]
}

statewright_readonly_operand_allowed() {
  [[ "$1" =~ ^[[:alnum:]_./:@%+=,\ -]+$ ]]
}

# Only checksum generation over explicit file operands, not check manifests,
# stdin, arbitrary options, interpreters, or shell-expanded operands.
statewright_checksum_tokens_allowed() {
  local executable="$1"
  shift
  local -a args=("$@")
  local index=0 operand
  if [ "$executable" = "shasum" ]; then
    [ "${args[0]:-}" = "-a" ] && [ "${args[1]:-}" = "256" ] || return 1
    index=2
  fi
  [ "${args[$index]:-}" = "--" ] && index=$((index + 1))
  [ "$index" -lt "${#args[@]}" ] || return 1
  while [ "$index" -lt "${#args[@]}" ]; do
    operand="${args[$index]}"
    [[ "$operand" != -* ]] && statewright_readonly_operand_allowed "$operand" || return 1
    index=$((index + 1))
  done
}

statewright_readonly_segment_capability() {
  local segment="$1" token arg
  STATEWRIGHT_SEGMENT_CAPABILITY=""
  statewright_readonly_tokens "$segment" || return 1
  token="${STATEWRIGHT_TOKENS[0]##*/}"
  [[ "$token" != *=* ]] || return 1

  case "$token" in
    sha256sum|shasum)
      statewright_checksum_tokens_allowed "$token" "${STATEWRIGHT_TOKENS[@]:1}" || return 1
      STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
    cat|head|tail|less|more|bat|xxd|ls|pwd|stat|file|wc|du|dirname|basename|realpath|jq|cut|tr|sort|uniq|which|true|false)
      STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
    grep|rg|ag|ack|ripgrep)
      # `rg --pre` executes an arbitrary preprocessor. Keep all such hooks
      # behind explicit Bash authority instead of Read-only fallback.
      for arg in "${STATEWRIGHT_TOKENS[@]:1}"; do
        [ "$arg" = "--pre" ] || [[ "$arg" == --pre=* ]] || continue
        return 1
      done
      STATEWRIGHT_SEGMENT_CAPABILITY="Grep" ;;
    find)
      for arg in "${STATEWRIGHT_TOKENS[@]:1}"; do
        case "$arg" in -delete|-exec|-execdir|-ok|-okdir|-fls|-fprint|-fprint0|-fprintf) return 1 ;; esac
      done
      STATEWRIGHT_SEGMENT_CAPABILITY="Glob" ;;
    fd)
      for arg in "${STATEWRIGHT_TOKENS[@]:1}"; do
        case "$arg" in --exec|--exec=*|--exec-batch|--exec-batch=*|-x|-X|-[^-]*x*|-[^-]*X*) return 1 ;; esac
      done
      STATEWRIGHT_SEGMENT_CAPABILITY="Glob" ;;
    locate|mdfind)
      STATEWRIGHT_SEGMENT_CAPABILITY="Glob" ;;
    sed|awk|gawk) return 1 ;;
    git)
      case "${STATEWRIGHT_TOKENS[1]:-}" in
        status|diff|log|show|rev-parse|ls-files|grep|describe)
          STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
        branch) case "${STATEWRIGHT_TOKENS[2]:-}" in --show-current|--list) STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;; *) return 1 ;; esac ;;
        *) return 1 ;;
      esac ;;
    command)
      case "${STATEWRIGHT_TOKENS[1]:-}" in
        -v) STATEWRIGHT_SEGMENT_CAPABILITY="Read" ;;
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
    ''|*$'\n'*|*$'\r'*|*'<'*|*'>'*|*'`'*|*'$'* ) return 1 ;;
  esac

  while IFS= read -r segment; do
    segment=$(printf '%s\n' "$segment" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
    [ -z "$segment" ] && continue
    statewright_readonly_segment_capability "$segment" || return 1
    # Workflows expose one provider-neutral read capability. Older policies
    # may still name Grep/Glob, so retain their narrower admission here.
    case "$STATEWRIGHT_SEGMENT_CAPABILITY" in
      Read|Grep|Glob)
        statewright_has_capability "Read" || statewright_has_capability "$STATEWRIGHT_SEGMENT_CAPABILITY" || return 1 ;;
      *) statewright_has_capability "$STATEWRIGHT_SEGMENT_CAPABILITY" || return 1 ;;
    esac
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
    statewright_uses_unsupported_shell "$tool_name" "$hook_input" && return 1
    command=$(statewright_input_command "$hook_input")
    [ -n "$command" ] || return 1
    # Provider shell adapters are also the concrete transport for canonical
    # Read operations. Classify strict reads before broad Bash authority so a
    # phase that grants both capabilities does not turn `cat`/`rg`/`find` into
    # Bash commands subject to an unrelated allowed_commands list.
    if statewright_readonly_shell_allowed "$command"; then
      STATEWRIGHT_TOOL_MODE="readonly_shell"
      return 0
    fi
    if statewright_has_capability "Bash" || statewright_has_capability "exec_command"; then
      STATEWRIGHT_TOOL_MODE="bash"
      return 0
    fi
    return 1
  fi

  statewright_has_capability "$tool_name" && { STATEWRIGHT_TOOL_MODE="direct"; return 0; }

  case "$tool_name" in
    Read|read_file|Grep|grep|search_files|Glob|glob|find|find_files|ls|list_directory)
      if statewright_has_capability "Read"; then
        STATEWRIGHT_TOOL_MODE="read"
        return 0
      fi ;;
    Edit|Write|MultiEdit|apply_patch|patch_file|edit_file|write_file|create_file|create_or_update_file)
      if statewright_has_capability "Write"; then
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
