#!/usr/bin/env bash
# Provider compatibility policy. Legacy workflows use an allowlist. Only an
# explicit opt-in workflow policy may use denylist/heuristic admission.

STATEWRIGHT_TOOL_MODE=""
STATEWRIGHT_ALLOWED_TOOLS=""
STATEWRIGHT_DISALLOWED_TOOLS=""
STATEWRIGHT_TOOL_POLICY_MODE=""

statewright_policy_mode_is_denylist() {
  [ "$1" = "denylist_heuristic_v1" ] || [ "$1" = "blacklist_heuristic_v1" ]
}

statewright_denylist_mode() {
  statewright_policy_mode_is_denylist "$STATEWRIGHT_TOOL_POLICY_MODE"
}

statewright_list_has_normalized() {
  local wanted entry
  wanted=$(statewright_normalize_tool "$1")
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    [ "$(statewright_normalize_tool "$entry")" = "$wanted" ] && return 0
  done <<< "$2"
  return 1
}

# Provider identities are not capability aliases. Removing punctuation here
# would conflate different servers and methods (for example a_b and ab).
statewright_list_has_exact() {
  local entry
  while IFS= read -r entry; do
    [ -n "$entry" ] && [ "$entry" = "$1" ] && return 0
  done <<< "$2"
  return 1
}

statewright_has_capability() {
  local capability="$1"
  if statewright_denylist_mode; then
    ! statewright_list_has_normalized "$capability" "$STATEWRIGHT_DISALLOWED_TOOLS"
  else
    statewright_list_has_normalized "$capability" "$STATEWRIGHT_ALLOWED_TOOLS"
  fi
}

statewright_normalize_tool() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]'
}

statewright_canonical_tool() {
  case "$(statewright_normalize_tool "$1")" in
    read|readfile|grep|searchfiles|glob|find|findfiles|ls|listdirectory|viewimage) printf 'Read' ;;
    edit|write|multiedit|applypatch|patchfile|editfile|writefile|createfile|createorupdatefile|writestdin) printf 'Write' ;;
    bash|execcommand|runcommand|shell|zsh) printf 'Bash' ;;
    webrun|websearch|webfetch) printf 'WebSearch' ;;
    imagegen|imagegenimagegen) printf 'ImageGen' ;;
    *) printf '' ;;
  esac
}

statewright_explicitly_blocked() {
  local raw="$1" canonical="$2"
  statewright_list_has_exact "$raw" "$STATEWRIGHT_DISALLOWED_TOOLS" && return 0
  [ -n "$canonical" ] && statewright_list_has_normalized "$canonical" "$STATEWRIGHT_DISALLOWED_TOOLS"
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

statewright_utility_has_exec_effect() {
  local command="$1" executable
  case "$command" in
    find[[:space:]]*|rg[[:space:]]*|ripgrep[[:space:]]*|fd[[:space:]]*) ;;
    *) return 1 ;;
  esac
  statewright_readonly_tokens "$command" || return 0
  executable="${STATEWRIGHT_TOKENS[0]##*/}"
  case "$executable" in
    find|rg|ripgrep|fd)
      # Reuse the quote-aware token parser and per-utility flag rules above.
      # A rejected utility argument is not safe merely because the executable
      # itself normally reads files.
      statewright_readonly_segment_capability "$command" || return 0 ;;
  esac
  return 1
}

# Classify Git by effect after the shell tokenizer has ruled out expansion and
# sequencing. It is a positive parser: unrecognized aliases/options remain
# opaque rather than becoming local writes solely because their executable is Git.
statewright_git_effect() {
  local command="$1" subcommand option token index=1
  statewright_readonly_tokens "$command" || return 1
  [ "${STATEWRIGHT_TOKENS[0]##*/}" = "git" ] || return 1
  while [ "$index" -lt "${#STATEWRIGHT_TOKENS[@]}" ]; do
    token="${STATEWRIGHT_TOKENS[$index]}"
    case "$token" in
      -C|--git-dir|--work-tree|--namespace)
        index=$((index + 1))
        [ "$index" -lt "${#STATEWRIGHT_TOKENS[@]}" ] || { printf 'opaque'; return; }
        index=$((index + 1)) ;;
      -C?*|--git-dir=*|--work-tree=*|--namespace=*) index=$((index + 1)) ;;
      -c|-c?*) printf 'opaque'; return ;;
      -*) printf 'opaque'; return ;;
      *) break ;;
    esac
  done
  subcommand="${STATEWRIGHT_TOKENS[$index]:-}"
  [ -n "$subcommand" ] || { printf 'opaque'; return; }
  case "$subcommand" in
    push|fetch|pull|clone|ls-remote) printf 'external'; return ;;
    reset)
      for option in "${STATEWRIGHT_TOKENS[@]:$((index + 1))}"; do [ "$option" = '--hard' ] && { printf 'irreversible'; return; }; done ;;
    clean)
      for option in "${STATEWRIGHT_TOKENS[@]:$((index + 1))}"; do [[ "$option" =~ ^-[^-]*f ]] && { printf 'irreversible'; return; }; done ;;
  esac
  local effect=""
  case "$subcommand" in
    status|log|diff|show|rev-parse|ls-files|grep|describe) effect='read' ;;
    branch)
      for option in "${STATEWRIGHT_TOKENS[@]:$((index + 1))}"; do
        case "$option" in --show-current|--list|-l|--no-color) ;; *) effect='local_write'; break ;; esac
      done
      [ -n "$effect" ] || effect='read' ;;
    tag)
      for option in "${STATEWRIGHT_TOKENS[@]:$((index + 1))}"; do
        case "$option" in --list|-l|--contains|--points-at|--no-contains|--merged|--no-merged) ;; *) effect='local_write'; break ;; esac
      done
      [ -n "$effect" ] || effect='read' ;;
    remote)
      case "${STATEWRIGHT_TOKENS[$((index + 1))]:-}" in ''|-v|get-url) effect='read' ;; *) effect='local_write' ;; esac ;;
    worktree)
      case "${STATEWRIGHT_TOKENS[$((index + 1))]:-}" in list) effect='read' ;; *) effect='local_write' ;; esac ;;
    add|commit|restore|switch|checkout|merge|rebase|stash|config|reset|clean) effect='local_write' ;;
    *) printf 'opaque'; return ;;
  esac
  if [ "$effect" = 'read' ]; then
    for option in "${STATEWRIGHT_TOKENS[@]:$((index + 1))}"; do
      case "$option" in --output|--output=*) printf 'local_write'; return ;; esac
    done
  fi
  printf '%s' "$effect"
}

# A redirect is a local write only when the command producing the output is a
# known non-executing producer.  A redirect cannot make an unknown executable
# safe to run.
statewright_known_redirect_write() {
  local command="$1" base
  base=$(printf '%s' "$command" | sed -E 's/[[:space:]][012]?>.*$//')
  case "$base" in
    printf[[:space:]]*|echo[[:space:]]*|cat[[:space:]]*|head[[:space:]]*|tail[[:space:]]*|wc[[:space:]]*|grep[[:space:]]*|rg[[:space:]]*|git[[:space:]]*) ;;
    *) return 1 ;;
  esac
  if [[ "$base" == git[[:space:]]* ]]; then
    [ "$(statewright_git_effect "$base")" = 'read' ] || return 1
  fi
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
  local command="$1" executable
  statewright_readonly_tokens "$command" || return 1
  executable="${STATEWRIGHT_TOKENS[0]##*/}"
  case "$executable" in tee|dd|cp|mv|ln|install|rsync|mkdir|touch|chmod|chown) return 0 ;; esac
  return 1
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

statewright_shell_effect() {
  local command="$1" normalized
  normalized=$(printf '%s' "$command" | sed -E 's/^[[:space:]]+//; s/^[[:space:]]*command[[:space:]]+//')
  case "$normalized" in *$'\n'*|*$'\r'*) printf 'opaque'; return ;; esac
  # A bare newline is a shell command separator. It must never inherit the
  # effect classification of the first line.
  # An irreversible or remote side-effect wins even when it follows a wrapper.
  if printf '%s\n' "$normalized" | grep -qE '(^|[;&|][[:space:]]*|[[:space:]])(/[^[:space:]]*/)?(rm|rmdir|shred|truncate|dd)([[:space:]]|$)|git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[^[:space:]]*f)'; then
    printf 'irreversible'
  elif printf '%s\n' "$normalized" | grep -qE '(^|[;&|][[:space:]]*)(curl|wget|ssh|scp|rsync[[:space:]].*[^[:space:]]:|git[[:space:]]+(push|fetch|pull|clone|ls-remote)|docker|podman|nerdctl|crictl)([[:space:]]|$)'; then
    printf 'external'
  elif [[ "$normalized" == *'&&'* ]]; then
    local segment effect
    while IFS= read -r segment; do
      effect=$(statewright_shell_effect "$segment")
      [ "$effect" = "read" ] || { printf 'opaque'; return; }
    done < <(printf '%s\n' "$normalized" | sed -E 's/[[:space:]]*&&[[:space:]]*/\n/g')
    printf 'read'
  elif statewright_utility_has_exec_effect "$normalized"; then
    # These utilities have quote-aware token parsing above. A leading read
    # executable is not sufficient evidence of a read-only effect.
    printf 'opaque'
  # A guarded shell command is a single operation. Do not let a safe first
  # word bless an unknown command hidden after sequencing, substitution, a
  # pipe, or input redirection. Output redirects are classified below because
  # authorised local writes are a valid implementation-phase operation.
  elif printf '%s\n' "$normalized" | grep -qE '[;&|`]|\$\(|<'; then
    printf 'opaque'
  elif statewright_has_file_write_redirect "$normalized"; then
    statewright_known_redirect_write "$normalized" && printf 'local_write' || printf 'opaque'
  else
    local git_effect
    git_effect="$(statewright_git_effect "$normalized" 2>/dev/null || true)"
    case "$git_effect" in
      read|local_write|external|irreversible|opaque) printf '%s' "$git_effect" ;;
      '')
        if statewright_has_file_write_primitive "$normalized"; then
          printf 'local_write'
        elif printf '%s\n' "$normalized" | grep -qE '^(ls|cat|head|tail|wc|file|find|tree|pwd|date|which|type|printenv|grep|rg|fd|ag)([[:space:]]|$)|^task[[:space:]]+(test|lint|check|build)(:|[[:space:]]|$)|^(npm|pnpm)[[:space:]]+(test|lint|check|build)([[:space:]]|$)|^pytest([[:space:]]|$)|^cargo[[:space:]]+(test|check|clippy)([[:space:]]|$)'; then
          printf 'read'
        else
          printf 'opaque'
        fi ;;
    esac
  fi
}

statewright_tool_allowed() {
  local tool_name="$1" hook_input="$2" normalized command canonical
  STATEWRIGHT_TOOL_MODE=""
  canonical=$(statewright_canonical_tool "$tool_name")

  # In deny mode, raw provider names and their canonical capability are both
  # hard denials. This must happen before poll/read/shell shortcuts.
  if statewright_explicitly_blocked "$tool_name" "$canonical"; then
    STATEWRIGHT_TOOL_MODE="blocked"
    return 1
  fi

  # Polling an existing native command is read-only. Sending input is a write
  # capability and must remain blocked in phases that explicitly disallow it.
  if [ "$tool_name" = "write_stdin" ]; then
    if printf '%s' "$hook_input" | jq -e '.tool_input | (has("chars") | not) or .chars == ""' >/dev/null 2>&1; then
      STATEWRIGHT_TOOL_MODE="poll"
      return 0
    fi
    statewright_has_capability "Write" && { STATEWRIGHT_TOOL_MODE="stdin_write"; return 0; }
    return 1
  fi

  # Shell tools must reach Bash discernment even when Bash itself is allowed.
  # Checking the raw tool name first would let redirects and in-place edits
  # bypass the state policy.
  if statewright_is_shell_tool "$tool_name"; then
    statewright_uses_unsupported_shell "$tool_name" "$hook_input" && return 1
    command=$(statewright_input_command "$hook_input")
    [ -n "$command" ] || return 1
    if statewright_denylist_mode; then
      STATEWRIGHT_TOOL_MODE="bash"
      return 0
    fi
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

  case "$tool_name" in
    Read|read_file|Grep|grep|search_files|Glob|glob|find|find_files|ls|list_directory)
      if statewright_has_capability "Read"; then
        STATEWRIGHT_TOOL_MODE="read"
        return 0
      fi
      return 1 ;;
    Edit|Write|MultiEdit|apply_patch|patch_file|edit_file|write_file|create_file|create_or_update_file)
      if statewright_has_capability "Write"; then
        STATEWRIGHT_TOOL_MODE="edit"
        return 0
      fi
      return 1 ;;
    view_image)
      if statewright_has_capability "Read"; then
        STATEWRIGHT_TOOL_MODE="read"
        return 0
      fi
      return 1 ;;
  esac

  normalized=$(statewright_normalize_tool "$tool_name")
  case "$normalized" in
    webrun)
      statewright_web_allowed "$hook_input" && { STATEWRIGHT_TOOL_MODE="web"; return 0; }
      return 1 ;;
    imagegenimagegen|imagegen)
      if statewright_has_capability "ImageGen"; then
        STATEWRIGHT_TOOL_MODE="image"
        return 0
      fi
      return 1 ;;
  esac

  # Legacy phases can authorize a provider operation explicitly. This is
  # permission from the workflow, not an inference that its effect is safe.
  # Built-in shell/edit checks above must not be bypassed by this rule.
  if ! statewright_denylist_mode && statewright_list_has_exact "$tool_name" "$STATEWRIGHT_ALLOWED_TOOLS"; then
    STATEWRIGHT_TOOL_MODE="explicit"
    return 0
  fi

  # No substring matching: an unknown tool's effect cannot be inferred from a
  # friendly name. Standalone execution must deny it; an executor may make a
  # semantic-risk/approval decision before invoking the real provider tool.
  STATEWRIGHT_TOOL_MODE="opaque"
  return 1
}
