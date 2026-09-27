//! Bash command classifier for guardrail enforcement.
//!
//! Classifies shell commands by operation type (file write, file read, destructive, etc.)
//! so that per-state tool restrictions extend to Bash commands. Without this, an agent
//! can bypass `Write` restrictions by using `cat > file << 'EOF'` through the `Bash` tool.

/// Operation class for a shell command segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpClass {
    /// Writing new content to a file (requires Write).
    FileWrite,
    /// Modifying a file in-place (requires Write).
    FileModify,
    /// Reading file contents (requires Read).
    FileRead,
    /// Searching file contents (requires Read).
    ContentSearch,
    /// Searching for files by name/path (requires Read).
    FileSearch,
    /// Destructive operations — always blocked in restricted states.
    Destructive,
    /// Network operations (requires WebFetch or explicit allowance).
    Network,
    /// Git write operations (requires explicit allowance).
    GitWrite,
    /// Git read operations (requires Read).
    GitRead,
    /// A bounded local state change (requires Write).
    LocalWrite,
    /// A known command whose only direct effect is bounded stdout output.
    SafeOutput,
    /// Shell syntax was recognized but could not be safely normalized.
    /// This is distinct from benign passthrough so risk assessment cannot
    /// discard the opaque effect when another class (such as a redirect)
    /// proves only part of the command.
    Opaque,
    /// Benign or unclassifiable — allowed if Bash itself is allowed.
    Passthrough,
}

/// Privacy-bounded shell structure for semantic risk assessment.
/// Operands and option values are intentionally omitted because they may
/// contain source code or credentials.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SemanticCommandShape {
    pub executable: String,
    pub operation: Option<String>,
    pub delegates_unknown_effect: bool,
}

/// Extract bounded command structure. Ambiguous syntax produces no shape and
/// therefore remains fail-closed at the semantic authorization boundary.
pub fn semantic_command_shapes(command: &str) -> Option<Vec<SemanticCommandShape>> {
    let mut shapes = Vec::new();
    for segment in split_segments(command).into_iter().take(8) {
        let tokens = simple_command_tokens(segment.trim())?;
        if tokens.is_empty() { continue; }
        let mut index = 0;
        while tokens.get(index).is_some_and(|token| token.contains('=') && !token.starts_with('=')) { index += 1; }
        if tokens.get(index).is_some_and(|token| token.rsplit('/').next() == Some("command")) { index += 1; }
        if tokens.get(index).is_some_and(|token| token.rsplit('/').next() == Some("env")) {
            index += 1;
            while tokens.get(index).is_some_and(|token| token.starts_with('-') || token.contains('=')) { index += 1; }
        }
        let executable = tokens.get(index)?.rsplit('/').next()?.to_ascii_lowercase();
        if !semantic_label(&executable) { return None; }
        index += 1;
        let operation = semantic_operation(&executable, &tokens[index..]);
        let delegates_unknown_effect = semantic_delegates_unknown_effect(&executable, operation.as_deref());
        shapes.push(SemanticCommandShape { executable, operation, delegates_unknown_effect });
    }
    (!shapes.is_empty()).then_some(shapes)
}

/// Conservatively detect a reference to a named environment variable without
/// executing a shell or using a text-search subprocess. Exact identifier
/// boundaries avoid treating `TOKEN_SUFFIX` as a reference to `TOKEN`.
pub fn references_environment_variable(command: &str, name: &str) -> bool {
    if name.is_empty()
        || !name.chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return false;
    }
    let bytes = command.as_bytes();
    let name_bytes = name.as_bytes();
    let is_name = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index + 1;
            if bytes.get(start) == Some(&b'{') {
                let variable_start = start + 1;
                if bytes.get(variable_start..variable_start + name_bytes.len()) == Some(name_bytes)
                    && bytes.get(variable_start + name_bytes.len()).is_some_and(|byte| !is_name(*byte))
                {
                    return true;
                }
            } else if bytes.get(start..start + name_bytes.len()) == Some(name_bytes)
                && bytes.get(start + name_bytes.len()).is_none_or(|byte| !is_name(*byte))
            {
                return true;
            }
        }
        let assignment_boundary = index == 0
            || bytes[index - 1].is_ascii_whitespace()
            || matches!(bytes[index - 1], b';' | b'|' | b'&' | b'(');
        if assignment_boundary
            && bytes.get(index..index + name_bytes.len()) == Some(name_bytes)
            && bytes.get(index + name_bytes.len()) == Some(&b'=')
        {
            return true;
        }
        index += 1;
    }
    false
}

fn semantic_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn semantic_operation(executable: &str, tokens: &[String]) -> Option<String> {
    if executable == "sed" && readonly_sed_args(tokens) {
        return Some("print".to_owned());
    }
    let mut index = 0;
    while tokens.get(index).is_some_and(|token| semantic_global_flag(executable, token)) { index += 1; }
    let candidate = tokens.get(index)?;
    let recognized = match executable {
        "cargo" => matches!(candidate.as_str(), "build" | "check" | "clippy" | "doc" | "fetch" | "fix" | "install" | "metadata" | "publish" | "remove" | "run" | "test" | "uninstall" | "update"),
        "docker" | "podman" => matches!(candidate.as_str(), "build" | "compose" | "create" | "exec" | "images" | "inspect" | "logs" | "ps" | "pull" | "push" | "rm" | "run" | "start" | "stop"),
        "git" => matches!(candidate.as_str(), "add" | "branch" | "clean" | "clone" | "commit" | "diff" | "fetch" | "log" | "ls-files" | "ls-remote" | "ls-tree" | "merge-base" | "pull" | "push" | "reset" | "restore" | "rev-parse" | "show" | "show-ref" | "status" | "tag" | "worktree"),
        "kubectl" => matches!(candidate.as_str(), "apply" | "create" | "delete" | "describe" | "exec" | "get" | "logs" | "patch" | "rollout" | "scale"),
        "npm" | "pnpm" => matches!(candidate.as_str(), "build" | "install" | "lint" | "publish" | "run" | "test" | "uninstall" | "update"),
        "systemctl" => matches!(candidate.as_str(), "disable" | "enable" | "is-active" | "restart" | "start" | "status" | "stop"),
        "tmux" => matches!(candidate.as_str(), "capture-pane" | "display-message" | "has-session" | "kill-pane" | "kill-session" | "list-panes" | "list-sessions" | "new-session" | "send-keys" | "show-options"),
        _ => false,
    };
    recognized.then(|| candidate.to_ascii_lowercase())
}

fn semantic_delegates_unknown_effect(executable: &str, operation: Option<&str>) -> bool {
    match (executable, operation) {
        ("task" | "cargo" | "docker" | "podman" | "kubectl" | "npm" | "pnpm", _) => true,
        ("tmux", Some("new-session" | "send-keys")) => true,
        _ => false,
    }
}

fn semantic_global_flag(executable: &str, token: &str) -> bool {
    match executable {
        "git" => matches!(token, "--bare" | "--no-pager" | "--no-optional-locks"),
        _ => false,
    }
}

impl OpClass {
    /// Returns the tool names required in `allowed_tools` for this operation class.
    /// Returns an empty slice for Passthrough (always allowed if Bash is).
    /// Returns `&["__BLOCKED__"]` for operations that require an explicit approval gate.
    pub fn required_tools(&self) -> &'static [&'static str] {
        match self {
            OpClass::FileWrite | OpClass::FileModify | OpClass::LocalWrite => &["Write"],
            OpClass::FileRead => &["Read"],
            // Read is the provider-neutral umbrella for native search/glob
            // calls as well as read-only shell searches.  Grep and Glob are
            // retained here solely for legacy state definitions: they were
            // narrower read capabilities, not write authority.
            OpClass::ContentSearch => &["Read", "Grep"],
            OpClass::FileSearch => &["Read", "Glob"],
            OpClass::Destructive => &["__DESTRUCTIVE__"],
            OpClass::Network => &["WebFetch"],
            OpClass::GitWrite => &["__GIT_WRITE__"],
            OpClass::GitRead => &["Read"],
            OpClass::SafeOutput | OpClass::Opaque | OpClass::Passthrough => &[],
        }
    }
}

/// Classify a shell command string into operation classes.
///
/// Splits on `&&`, `;`, `|` and classifies each segment.
/// Redirect operators (`>`, `>>`) upgrade the classification to FileWrite.
pub fn classify(command: &str) -> Vec<OpClass> {
    let segments = split_segments(command);
    let mut classes = Vec::new();

    for seg in &segments {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        classes.push(classify_segment(seg));
    }

    // A known outer command does not make nested shell execution safe. Keep
    // command/process substitution visible as an opaque effect so a local
    // write or redirect cannot erase the nested command's authority.
    if has_nested_shell_execution(command) && !classes.contains(&OpClass::Opaque) {
        classes.push(OpClass::Opaque);
    }

    // `send-keys` can execute arbitrary terminal input, so only promote the
    // one orchestration form whose complete command is structurally proven.
    if segments.len() == 1 && is_bounded_tmux_goal_dispatch(command) {
        classes.retain(|class| *class != OpClass::Passthrough);
        classes.push(OpClass::LocalWrite);
    }

    // Check for output redirects across the whole command (they can appear anywhere)
    if has_output_redirect(command) {
        if !classes.contains(&OpClass::FileWrite) {
            classes.push(OpClass::FileWrite);
        }
    }

    if classes.is_empty() {
        classes.push(OpClass::Passthrough);
    }

    classes.sort_by_key(|c| *c as u8);
    classes.dedup();
    classes
}

/// Check whether a command's operation classes are permitted by the given allowed_tools.
///
/// Returns `Ok(())` if all operations are permitted, or `Err(reason)` with a human-readable
/// explanation of what was blocked and why.
pub fn check_against_allowed(command: &str, allowed_tools: &[String]) -> Result<(), String> {
    let classes = classify(command);

    for class in &classes {
        let required = class.required_tools();
        if required.is_empty() {
            continue; // Passthrough — always ok
        }

        // Special sentinel: always blocked in restricted states
        if required.iter().any(|r| r.starts_with("__")) {
            return Err(format!(
                "Command '{}' performs a {:?} operation which is not permitted in this state.",
                truncate_command(command),
                class,
            ));
        }

        // Check if ANY of the required tools is in allowed_tools
        let has_required = required.iter().any(|req| {
            allowed_tools
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(req))
        });

        if !has_required {
            return Err(format!(
                "Command '{}' performs a {:?} operation which requires {} in allowed_tools.",
                truncate_command(command),
                class,
                required.join(" or "),
            ));
        }
    }

    Ok(())
}

/// Return the workflow capabilities needed by a strictly read-only shell command.
///
/// This is narrower than general Bash admission: unknown commands, shell expansion,
/// redirects, environment assignments, network access, and every write/destructive
/// class fail closed instead of inheriting the broad `Bash` capability.
pub fn readonly_capabilities(command: &str) -> Option<Vec<&'static str>> {
    if command.trim().is_empty()
        || command
            .chars()
            .any(|character| ['\n', '\r', '`'].contains(&character))
        || command.contains("$(")
    {
        return None;
    }
    let command = strip_readonly_stderr_sink(command)?;

    let mut capabilities = Vec::new();
    for segment in split_segments(&command) {
        let segment = segment.trim();
        let tokens = simple_command_tokens(segment)?;
        let first = tokens.first()?;
        if first.contains('=') {
            return None;
        }
        if readonly_search_has_external_hook(segment) {
            return None;
        }
        if first.rsplit('/').next() == Some("sed") && first != "sed" {
            return None;
        }
        if first.rsplit('/').next()? == "git" {
            if first != "git" {
                return None;
            }
            capabilities.push(readonly_git_capability(&tokens)?);
            continue;
        }
        let capability = match classify_segment(segment) {
            OpClass::FileRead | OpClass::GitRead => "Read",
            OpClass::ContentSearch => "Grep",
            OpClass::FileSearch => "Glob",
            OpClass::SafeOutput => "Read",
            OpClass::Passthrough => readonly_passthrough_capability(segment)?,
            OpClass::Opaque => return None,
            OpClass::FileWrite
            | OpClass::FileModify
            | OpClass::LocalWrite
            | OpClass::Destructive
            | OpClass::Network
            | OpClass::GitWrite => return None,
        };
        capabilities.push(capability);
    }
    capabilities.sort_unstable();
    capabilities.dedup();
    (!capabilities.is_empty()).then_some(capabilities)
}

/// Remove only the shell's exact stderr-to-null discard form. Every other
/// unquoted redirection stays outside the read-only proof surface.
fn strip_readonly_stderr_sink(command: &str) -> Option<String> {
    const SINK: &str = "2>/dev/null";
    let mut normalized = String::with_capacity(command.len());
    let mut index = 0;
    let mut quote = None;

    while index < command.len() {
        let rest = command.get(index..)?;
        let character = rest.chars().next()?;
        if let Some(active_quote) = quote {
            normalized.push(character);
            index += character.len_utf8();
            if character == active_quote {
                quote = None;
            } else if active_quote == '"' && character == '\\' {
                let escaped = command.get(index..)?.chars().next()?;
                normalized.push(escaped);
                index += escaped.len_utf8();
            }
            continue;
        }
        if matches!(character, '\'' | '"') {
            quote = Some(character);
            normalized.push(character);
            index += character.len_utf8();
            continue;
        }
        let previous_is_boundary = index == 0
            || command[..index]
                .chars()
                .next_back()
                .is_some_and(|value| value.is_whitespace() || matches!(value, ';' | '|' | '&'));
        if previous_is_boundary && rest.starts_with(SINK) {
            let end = index + SINK.len();
            let next_is_boundary = command.get(end..).is_some_and(|tail| {
                tail.is_empty()
                    || tail
                        .chars()
                        .next()
                        .is_some_and(|value| value.is_whitespace() || matches!(value, ';' | '|' | '&'))
            });
            if next_is_boundary {
                normalized.push(' ');
                index = end;
                continue;
            }
        }
        if matches!(character, '<' | '>') {
            return None;
        }
        normalized.push(character);
        index += character.len_utf8();
    }
    quote.is_none().then_some(normalized)
}

/// `classify_git` is deliberately broad for ordinary Bash capability checks.
/// Exploratory admission is intentionally a small proof surface. It admits
/// only Git forms that disable the configurable helpers Git can execute; it
/// does not try to classify every Git read-like subcommand. In particular,
/// log/show/reflog/stash are excluded because signature and log configuration
/// can invoke an externally configured verifier.
fn readonly_git_capability(tokens: &[String]) -> Option<&'static str> {
    let args = tokens.get(1..)?;
    // The end-of-options marker is meaningful to Git: operands after it can
    // create a branch/tag, so retain the complete argv rather than slicing it
    // away before the command grammar inspects it.
    let subcommand_index = args.iter().position(|arg| !arg.starts_with('-'))?;
    let subcommand = args.get(subcommand_index)?.as_str();
    let global_options = &args[..subcommand_index];
    let command_args = &args[subcommand_index + 1..];
    let unsafe_flag = |arg: &String| {
        matches!(arg.as_str(), "-c" | "--config-env" | "--exec-path" | "--ext-diff" | "--no-index" | "--output" | "-o" | "--textconv")
            || arg.starts_with("-c")
            || arg.starts_with("--config-env=")
            || arg.starts_with("--exec-path=")
            || arg.starts_with("--output=")
    };
    if args.iter().any(unsafe_flag)
        || !global_options.iter().all(|arg| matches!(arg.as_str(), "--no-pager" | "--no-optional-locks"))
    {
        return None;
    }
    let no_pager = global_options.iter().any(|arg| arg == "--no-pager");
    match subcommand {
        // These built-in Git plumbing/introspection commands do not invoke
        // configurable diff, text-conversion, signing, or pager helpers. The
        // shell parser above has already rejected expansion, redirection, and
        // unsafe global options, so they are deterministic local reads.
        "rev-parse" | "ls-files" | "ls-tree" | "merge-base" | "show-ref" => Some("Read"),
        // Branch listing is also a bounded read. Keep creation/deletion forms
        // out by reusing the complete argv classifier instead of matching the
        // subcommand name alone.
        "branch" if matches!(
            classify_git(&tokens.iter().map(String::as_str).collect::<Vec<_>>()),
            OpClass::GitRead
        ) => Some("Read"),
        "diff" if no_pager => {
            let boundary = command_args
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(command_args.len());
            let options = &command_args[..boundary];
            // A deliberately finite grammar: only these two helper-disabling
            // options precede optional revision/path operands.  This avoids
            // treating a flag-shaped operand or another option's value as a
            // proof that Git cannot start a configured helper.
            (options.iter().any(|arg| arg == "--no-ext-diff")
                && options.iter().any(|arg| arg == "--no-textconv")
                && options.iter().all(|arg| {
                    matches!(arg.as_str(), "--no-ext-diff" | "--no-textconv")
                }))
            .then_some("Read")
        }
        "branch" | "tag" if no_pager => {
            let boundary = command_args
                .iter()
                .position(|arg| arg == "--")
                .unwrap_or(command_args.len());
            let before_boundary = &command_args[..boundary];
            let has_boundary = boundary < command_args.len();
            let after_boundary = if has_boundary {
                &command_args[boundary + 1..]
            } else {
                &[]
            };
            if command_args.is_empty() {
                Some("Read")
            } else if matches!(before_boundary.first().map(String::as_str), Some("--list" | "-l"))
                && before_boundary[1..]
                    .iter()
                    .all(|arg| !arg.starts_with('-') && !arg.is_empty())
                && (!has_boundary || after_boundary.iter().all(|arg| !arg.is_empty()))
            {
                Some("Read")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Match one simple command against an allowed token prefix.
///
/// An entry such as `cargo test` permits `cargo test -p statewright-engine`, but
/// shell composition, redirection, expansion, and prefix collisions are rejected.
pub fn matches_allowed_command(command: &str, allowed: &str) -> bool {
    let Some(command_tokens) = simple_command_tokens(command) else {
        return false;
    };
    let Some(allowed_tokens) = simple_command_tokens(allowed) else {
        return false;
    };
    if allowed_tokens.first().is_some_and(|token| token == "task")
        && allowed_tokens.last().is_some_and(|token| token.ends_with(":*"))
    {
        if command_tokens.len() < allowed_tokens.len() {
            return false;
        }
        let namespace_index = allowed_tokens.len() - 1;
        if command_tokens[..namespace_index] != allowed_tokens[..namespace_index] {
            return false;
        }
        let namespace = allowed_tokens[namespace_index].trim_end_matches('*');
        let task_name = &command_tokens[namespace_index];
        let suffix = task_name.strip_prefix(namespace).unwrap_or_default();
        return !suffix.is_empty()
            && suffix
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, ':' | '_' | '-'));
    }
    !allowed_tokens.is_empty()
        && command_tokens.len() >= allowed_tokens.len()
        && command_tokens[..allowed_tokens.len()] == allowed_tokens
}

// --- Internal helpers ---

fn simple_command_tokens(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None;

    while let Some(ch) = chars.next() {
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            Some('"') => match ch {
                '"' => quote = None,
                '\\' => current.push(chars.next()?),
                '`' | '$' => return None,
                _ => current.push(ch),
            },
            Some(_) => unreachable!(),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                '\\' => current.push(chars.next()?),
                ' ' | '\t' => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                ';' | '|' | '&' | '>' | '<' | '\n' | '\r' | '`' | '$' => return None,
                _ => current.push(ch),
            },
        }
    }
    if quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}

/// Detect shell constructs that execute a nested command or introduce a
/// compound-command boundary while respecting quoting and escapes. Literal
/// text in single quotes is inert; command substitution remains active in
/// double quotes.
fn has_nested_shell_execution(command: &str) -> bool {
    let mut chars = command.chars().peekable();
    let mut quote = None;
    while let Some(ch) = chars.next() {
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                }
            }
            Some('"') => match ch {
                '"' => quote = None,
                '\\' => {
                    chars.next();
                }
                '`' => return true,
                '$' if chars.peek() == Some(&'(') => return true,
                _ => {}
            },
            Some(_) => unreachable!(),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                '\\' => {
                    chars.next();
                }
                '`' => return true,
                '$' if chars.peek() == Some(&'(') => return true,
                '<' | '>' if chars.peek() == Some(&'(') => return true,
                '(' | ')' | '{' | '}' => return true,
                _ => {}
            },
        }
    }
    false
}

/// Parse a single Git command while removing shell redirection operators and
/// their targets from argv. Unlike the generic simple parser, this keeps
/// quoted or escaped Git action names visible so `git "push" >receipt` cannot
/// hide an external effect behind the redirect's local file write.
fn git_command_tokens(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None;
    let mut redirect_target = false;

    while let Some(ch) = chars.next() {
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            Some('"') => match ch {
                '"' => quote = None,
                '\\' => {
                    let escaped = chars.next()?;
                    current.push(escaped);
                }
                '`' | '$' => return None,
                _ => current.push(ch),
            },
            Some(_) => unreachable!(),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                '\\' => {
                    let escaped = chars.next()?;
                    current.push(escaped);
                }
                ' ' | '\t' => {
                    if redirect_target {
                        if !current.is_empty() {
                            if network_pseudo_device_target(&current) {
                                return None;
                            }
                            redirect_target = false;
                            current.clear();
                        }
                    } else if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                '>' | '<' => {
                    if chars.peek() == Some(&'(') {
                        return None;
                    }
                    if redirect_target && !current.is_empty() {
                        if network_pseudo_device_target(&current) {
                            return None;
                        }
                        current.clear();
                    }
                    if !redirect_target && !current.is_empty() {
                        if !current.bytes().all(|byte| byte.is_ascii_digit()) {
                            tokens.push(std::mem::take(&mut current));
                        } else {
                            current.clear();
                        }
                    }
                    if chars.peek() == Some(&ch) {
                        chars.next();
                    }
                    if chars.peek() == Some(&'&') {
                        chars.next();
                    }
                    redirect_target = true;
                }
                // Unquoted brace and pathname expansion can rewrite Git's
                // action token before execution (for example `p{u..u}sh` or
                // `rem*`). Preserve that as opaque instead of classifying the
                // pre-expansion spelling. Quoted/escaped literals remain safe.
                ';' | '|' | '&' | '\n' | '\r' | '`' | '$'
                | '{' | '}' | '*' | '?' | '[' | ']' => return None,
                _ => current.push(ch),
            },
        }
    }
    if quote.is_some() || (redirect_target && current.is_empty()) {
        return None;
    }
    if redirect_target && network_pseudo_device_target(&current) {
        return None;
    }
    if !redirect_target && !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}

fn network_pseudo_device_target(target: &str) -> bool {
    target.starts_with("/dev/tcp/") || target.starts_with("/dev/udp/")
}

fn readonly_passthrough_capability(segment: &str) -> Option<&'static str> {
    let tokens = simple_command_tokens(segment)?;
    let invoked = tokens.first()?.as_str();
    // Keep label output on a deliberately finite grammar. Bash `printf` can
    // mutate shell variables via `-v` and `%n`; path-qualified lookalikes are
    // arbitrary executables rather than the known utility/builtin.
    if invoked == "echo" {
        return Some("Read");
    }
    if invoked == "printf"
        && tokens.len() == 2
        && !tokens[1].starts_with("-v")
        && !tokens[1].contains('%')
    {
        return Some("Read");
    }
    // `test` and `[` are shell predicates. With expansions, redirections, and
    // composition already rejected by `simple_command_tokens`, they can only
    // inspect strings, shell state, or filesystem metadata. Require the exact
    // builtin spellings so a path-qualified lookalike cannot borrow Read.
    if invoked == "test" && readonly_test_predicate(&tokens[1..]) {
        return Some("Read");
    }
    if invoked == "["
        && tokens.last().is_some_and(|token| token == "]")
        && readonly_test_predicate(&tokens[1..tokens.len() - 1])
    {
        return Some("Read");
    }
    let executable = invoked.rsplit('/').next()?;
    match executable {
        "sha256sum" | "shasum" if readonly_checksum_args(executable, &tokens[1..]) => Some("Read"),
        "ls" | "pwd" | "stat" | "file" | "wc" | "du" | "dirname" | "basename" | "realpath"
        | "jq" | "cut" | "tr" | "which" | "true" | "false" => Some("Read"),
        "command" if tokens.get(1).is_some_and(|argument| argument == "-v") => Some("Read"),
        _ => None,
    }
}

/// Prove a finite stdout-only command even when stdout is redirected. The
/// redirect-aware parser rejects expansions and shell composition before
/// removing the redirect target, so only literal bare echo/printf calls get
/// deterministic SafeOutput treatment.
fn safe_output_command(segment: &str, invoked: &str) -> bool {
    if !matches!(invoked, "echo" | "printf") {
        return false;
    }
    let Some(tokens) = git_command_tokens(segment) else {
        return false;
    };
    let Some(command_index) = tokens
        .iter()
        .position(|token| !token.contains('=') || token.starts_with('-'))
    else {
        return false;
    };
    if tokens.get(command_index).map(String::as_str) != Some(invoked) {
        return false;
    }
    if invoked == "echo" {
        return true;
    }
    let args = &tokens[command_index + 1..];
    args.len() == 1 && !args[0].starts_with("-v") && !args[0].contains('%')
}

/// Admit a deliberately finite subset of shell predicates. In particular,
/// Bash's `-v array[index-expression]` form evaluates the subscript as shell
/// arithmetic and can mutate variables, so only scalar identifiers are
/// accepted for `-v`.
fn readonly_test_predicate(args: &[String]) -> bool {
    let args = if args.first().is_some_and(|argument| argument == "!") {
        &args[1..]
    } else {
        args
    };
    match args {
        [value] => !value.is_empty(),
        [operator, operand]
            if matches!(
                operator.as_str(),
                "-b" | "-c" | "-d" | "-e" | "-f" | "-h" | "-L" | "-n" | "-p"
                    | "-r" | "-S" | "-s" | "-t" | "-v" | "-w" | "-x" | "-z"
            ) =>
        {
            operator != "-v" || is_shell_identifier(operand)
        }
        [_, operator, _]
            if matches!(
                operator.as_str(),
                "=" | "==" | "!=" | "-ef" | "-eq" | "-ge" | "-gt" | "-le" | "-lt"
                    | "-ne" | "-nt" | "-ot"
            ) => true,
        _ => false,
    }
}

fn is_shell_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn classify_tmux(segment: &str) -> OpClass {
    let Some(tokens) = simple_command_tokens(segment) else {
        return OpClass::Passthrough;
    };
    if tokens.first().and_then(|token| token.rsplit('/').next()) != Some("tmux") {
        return OpClass::Passthrough;
    }
    let Some(operation) = tokens.get(1).map(String::as_str) else {
        return OpClass::Passthrough;
    };
    let args = &tokens[2..];
    let has_shell_format = args.iter().any(|argument| argument.contains("#("));
    match operation {
        "capture-pane" if args.iter().any(|argument| argument == "-p")
            && !args.iter().any(|argument| argument == "-b" || argument.starts_with("-b="))
            && !has_shell_format => OpClass::FileRead,
        "display-message" if args.iter().any(|argument| argument == "-p")
            && !has_shell_format => OpClass::FileRead,
        "has-session" | "list-panes" | "list-sessions" | "show-options"
            if !has_shell_format => OpClass::FileRead,
        "capture-pane" | "display-message" => OpClass::LocalWrite,
        "kill-pane" | "kill-session" => OpClass::Destructive,
        _ => OpClass::Passthrough,
    }
}

fn is_bounded_tmux_goal_dispatch(command: &str) -> bool {
    if command.len() > 4_096 || command.chars().any(char::is_control) {
        return false;
    }
    let Some(tokens) = simple_command_tokens(command.trim()) else {
        return false;
    };
    let [executable, operation, target_flag, target, goal, submit] = tokens.as_slice() else {
        return false;
    };
    executable.rsplit('/').next() == Some("tmux")
        && operation == "send-keys"
        && target_flag == "-t"
        && target.strip_prefix('%').is_some_and(|pane| {
            !pane.is_empty() && pane.bytes().all(|byte| byte.is_ascii_digit())
        })
        && goal.strip_prefix("/goal ").is_some_and(|body| !body.trim().is_empty())
        && matches!(submit.as_str(), "Enter" | "C-m")
}

/// Ripgrep's `--pre` option starts an arbitrary preprocessor for each searched
/// file. It is safe only under explicit Bash authority, never when a shell
/// invocation is borrowing the provider-neutral Read capability.
fn readonly_search_has_external_hook(segment: &str) -> bool {
    let Some(tokens) = simple_command_tokens(segment) else {
        return true;
    };
    let Some(executable) = tokens.first().and_then(|token| token.rsplit('/').next()) else {
        return true;
    };
    matches!(executable, "rg" | "ripgrep")
        && tokens[1..]
            .iter()
            .any(|argument| argument == "--pre" || argument.starts_with("--pre="))
}

// Match the Codex hook's narrow checksum-generation surface. In particular,
// reading a checksum manifest (-c) and invoking an interpreter are not implied.
fn readonly_checksum_args(executable: &str, args: &[String]) -> bool {
    let args = if executable == "shasum" {
        if args.len() < 3 || args[0] != "-a" || args[1] != "256" {
            return false;
        }
        &args[2..]
    } else {
        args
    };
    let args = if args.first().is_some_and(|arg| arg == "--") {
        &args[1..]
    } else {
        args
    };
    !args.is_empty() && args.iter().all(|arg| {
        arg.starts_with(|ch: char| ch.is_ascii_alphanumeric() || "_./".contains(ch))
            && arg.chars().all(|ch| ch.is_ascii_alphanumeric() || "_./:@%+=, -".contains(ch))
    })
}

/// Admit only sed's bounded print-only viewer form. Arbitrary sed programs can
/// write files (`w`), execute commands (`e`), or load a script file, so they
/// remain semantic-fallback candidates instead of inheriting Read authority.
fn readonly_sed_args(args: &[String]) -> bool {
    let Some(quiet) = args.first().map(String::as_str) else {
        return false;
    };
    if !matches!(quiet, "-n" | "--quiet" | "--silent") {
        return false;
    }

    let mut index = 1;
    let explicit_program_flag = args.get(index).is_some_and(|argument| argument == "-e");
    if explicit_program_flag {
        index += 1;
    }
    let Some(program) = args.get(index) else {
        return false;
    };
    if !readonly_sed_print_program(program) {
        return false;
    }
    index += 1;

    let has_end_of_options = args.get(index).is_some_and(|argument| argument == "--");
    if has_end_of_options {
        index += 1;
    }
    let operands = &args[index..];
    // With no operand, sed reads stdin. The admitted program grammar is still
    // print-only, so this is safe for a pipeline viewer and cannot write or
    // execute merely because the producer is connected through a pipe.
    (operands.is_empty() && !explicit_program_flag)
        || (!operands.is_empty()
            && operands.iter().all(|operand| {
                !operand.is_empty()
                    && (has_end_of_options || operand == "-" || !operand.starts_with('-'))
            }))
}

fn readonly_sed_print_program(program: &str) -> bool {
    let Some(addresses) = program.strip_suffix('p') else {
        return false;
    };
    if addresses.is_empty() {
        return false;
    }
    let mut parts = addresses.split(',');
    let Some(first) = parts.next() else {
        return false;
    };
    let second = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let valid_address = |address: &str| {
        address == "$"
            || (!address.is_empty()
                && address.bytes().all(|byte| byte.is_ascii_digit()))
    };
    valid_address(first) && second.is_none_or(valid_address)
}

fn sed_has_in_place(args: &[String]) -> bool {
    let mut end_of_options = false;
    args.iter().any(|argument| {
        if argument == "--" {
            end_of_options = true;
            return false;
        }
        !end_of_options
            && (argument == "--in-place"
                || argument.starts_with("--in-place=")
                || (argument.starts_with('-')
                    && !argument.starts_with("--")
                    && argument[1..].chars().any(|flag| flag == 'i')))
    })
}

/// Split a command string on `&&`, `||`, `;`, and `|` (single pipe).
/// This is deliberately simple — not a full shell parser.
fn split_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    while let Some(ch) = chars.next() {
        if ch == '\'' && !in_double_quote {
            in_single_quote = !in_single_quote;
            current.push(ch);
            continue;
        }
        if ch == '"' && !in_single_quote {
            in_double_quote = !in_double_quote;
            current.push(ch);
            continue;
        }
        if in_single_quote || in_double_quote {
            current.push(ch);
            continue;
        }

        match ch {
            '&' if chars.peek() == Some(&'&') => {
                chars.next(); // consume second &
                segments.push(current.clone());
                current.clear();
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next(); // consume second |
                segments.push(current.clone());
                current.clear();
            }
            '|' => {
                // Single pipe — split into separate segment
                segments.push(current.clone());
                current.clear();
            }
            ';' => {
                segments.push(current.clone());
                current.clear();
            }
            _ => {
                current.push(ch);
            }
        }
    }

    if !current.trim().is_empty() {
        segments.push(current);
    }

    segments
}

/// Classify a single command segment (no pipes, no `&&`/`;`).
fn classify_segment(segment: &str) -> OpClass {
    let tokens: Vec<&str> = segment.split_whitespace().collect();
    if tokens.is_empty() {
        return OpClass::Passthrough;
    }

    // Skip leading env var assignments (FOO=bar command ...)
    let cmd_idx = tokens
        .iter()
        .position(|t| !t.contains('=') || t.starts_with('-'));
    let invoked = match cmd_idx {
        Some(idx) => tokens[idx],
        None => return OpClass::Passthrough,
    };

    // Strip path prefix: /usr/bin/grep → grep
    let base_cmd = invoked.rsplit('/').next().unwrap_or(invoked);

    match base_cmd {
        "echo" | "printf" if safe_output_command(segment, invoked) => OpClass::SafeOutput,

        // File read commands
        "cat" | "head" | "tail" => {
            // cat with redirect is FileWrite — handled by has_output_redirect
            OpClass::FileRead
        }

        // Content search
        "grep" | "rg" | "ag" | "ack" | "ripgrep" => OpClass::ContentSearch,

        // File search. `find` can execute or write, so its action forms are
        // never admitted as a provider-neutral read operation.
        "find" => {
            if find_has_action(segment) {
                OpClass::Destructive
            } else {
                OpClass::FileSearch
            }
        }
        "fd" => {
            if fd_has_execution(segment) {
                OpClass::Destructive
            } else {
                OpClass::FileSearch
            }
        }
        "locate" | "mdfind" => OpClass::FileSearch,

        // File modify (in-place)
        "sed" => {
            let Some(parsed) = simple_command_tokens(segment) else {
                return OpClass::Passthrough;
            };
            if sed_has_in_place(&parsed[1..]) {
                OpClass::FileModify
            } else if readonly_sed_args(&parsed[1..]) {
                OpClass::FileRead
            } else {
                OpClass::Passthrough
            }
        }
        "awk" | "gawk" => {
            if tokens
                .iter()
                .any(|t| *t == "-i" && tokens.iter().any(|t2| *t2 == "inplace"))
            {
                OpClass::FileModify
            } else {
                OpClass::Passthrough
            }
        }
        "perl" => {
            if tokens
                .iter()
                .any(|t| *t == "-pi" || *t == "-p" || *t == "-i")
            {
                OpClass::FileModify
            } else {
                OpClass::Passthrough
            }
        }
        "patch" => OpClass::FileModify,

        // File write
        "tee" => OpClass::FileWrite,
        "cp" | "mv" | "install" | "rsync" => OpClass::FileWrite,
        "dd" => OpClass::FileWrite,

        // Destructive
        "rm" | "rmdir" | "shred" | "truncate" | "unlink" => OpClass::Destructive,

        // Network
        "curl" | "wget" | "nc" | "ncat" | "netcat" | "ssh" | "scp" | "sftp" => OpClass::Network,

        // Git — classify by subcommand
        "git" if invoked == "git" => {
            let conservative = classify_git(&tokens);
            let Some(parsed) = git_command_tokens(segment) else {
                return if matches!(
                    conservative,
                    OpClass::Destructive | OpClass::Network | OpClass::GitWrite
                ) {
                    conservative
                } else {
                    OpClass::Opaque
                };
            };
            let parsed = parsed.iter().map(String::as_str).collect::<Vec<_>>();
            classify_git(&parsed)
        }
        "git" => OpClass::Passthrough,

        // Tmux reads and bounded local orchestration. Arbitrary send-keys and
        // session creation remain passthrough for semantic fail-closed review.
        "tmux" => classify_tmux(segment),

        // Everything else
        _ => OpClass::Passthrough,
    }
}

/// Detect write/execute actions after shell quoting and escapes have been
/// resolved. A parser failure is unsafe for classification and fails closed.
fn find_has_action(segment: &str) -> bool {
    let Some(tokens) = simple_command_tokens(segment) else {
        return true;
    };
    tokens.iter().skip(1).any(|token| {
        matches!(token.as_str(), "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fls" | "-fprint" | "-fprint0" | "-fprintf")
    })
}

/// fd can execute an arbitrary command through either long or short exec
/// flags. As with find actions, parsing ambiguity fails closed.
fn fd_has_execution(segment: &str) -> bool {
    let Some(tokens) = simple_command_tokens(segment) else {
        return true;
    };
    tokens.iter().skip(1).any(|token| {
        matches!(token.as_str(), "-x" | "-X")
            // fd accepts short option clusters.  Treat any cluster containing
            // its exec switches as executable rather than trying to interpret
            // the remaining short options.
            || (token.starts_with('-')
                && !token.starts_with("--")
                && token[1..].chars().any(|flag| matches!(flag, 'x' | 'X')))
            || token == "--exec"
            || token.starts_with("--exec=")
            || token == "--exec-batch"
            || token.starts_with("--exec-batch=")
    })
}

/// Classify a git command by its subcommand.
fn classify_git(tokens: &[&str]) -> OpClass {
    // Admit only global switches that do not consume a following operand or
    // configure executable helpers. Treat `-C`, `-c`, `--config-env`, and all
    // other global forms as opaque rather than mistaking their values for the
    // subcommand.
    let mut subcommand_index = 1;
    while matches!(
        tokens.get(subcommand_index).copied(),
        Some("--no-pager" | "--no-optional-locks")
    ) {
        subcommand_index += 1;
    }
    let subcmd = tokens.get(subcommand_index).copied().filter(|token| !token.starts_with('-'));

    match subcmd {
        Some("log") | Some("status") | Some("diff") | Some("blame") | Some("show")
        | Some("reflog") | Some("rev-parse") | Some("ls-files") | Some("ls-tree")
        | Some("merge-base") | Some("show-ref") => OpClass::GitRead,

        Some("branch") => git_ref_listing_only(tokens, "branch"),
        Some("tag") => git_ref_listing_only(tokens, "tag"),
        Some("stash") => {
            if tokens.iter().any(|token| matches!(*token, "list" | "show")) {
                OpClass::GitRead
            } else {
                OpClass::GitWrite
            }
        }
        Some("worktree") => classify_git_worktree(tokens),

        Some("commit") | Some("push") | Some("reset") | Some("rebase") | Some("merge")
        | Some("cherry-pick") | Some("revert") | Some("am") => OpClass::GitWrite,

        Some("checkout") | Some("restore") | Some("switch") => {
            // checkout -- file is destructive, checkout branch is read-ish
            if tokens.iter().any(|t| *t == "--") {
                OpClass::GitWrite
            } else {
                OpClass::GitRead
            }
        }

        Some("clean") => OpClass::Destructive,
        Some("clone") | Some("fetch") | Some("pull") => OpClass::Network,
        Some("add") => OpClass::Passthrough, // staging is local, not a write
        _ => OpClass::Passthrough,
    }
}

/// `git worktree` without an action, or with `list`, is observational. Bounded
/// setup/maintenance actions mutate only local repository metadata or paths;
/// removal is destructive. Unknown forms fail closed through the ordinary
/// semantic fallback.
fn classify_git_worktree(tokens: &[&str]) -> OpClass {
    let Some(index) = tokens.iter().position(|token| *token == "worktree") else {
        return OpClass::Passthrough;
    };
    match tokens.get(index + 1).copied() {
        None | Some("list") => OpClass::GitRead,
        Some("add" | "lock" | "move" | "repair" | "unlock") => OpClass::LocalWrite,
        Some("prune" | "remove") => OpClass::Destructive,
        Some(_) => OpClass::Passthrough,
    }
}

/// Ref creation is mutating.  Keep the read classifier deliberately small:
/// no positional ref means a listing, and explicit list/show flags are reads.
fn git_ref_listing_only(tokens: &[&str], subcommand: &str) -> OpClass {
    let Some(index) = tokens.iter().position(|token| *token == subcommand) else {
        return OpClass::GitWrite;
    };
    let args = &tokens[index + 1..];
    // Mutation flags remain authoritative even when combined with --list.
    // Git accepts several of these in mixed forms, so an earlier listing flag
    // must never erase a later create/delete/move/copy/upstream operation.
    if args.iter().any(|token| {
        matches!(
            *token,
            "-d" | "-D"
                | "-m"
                | "-M"
                | "-c"
                | "-C"
                | "--delete"
                | "--move"
                | "--copy"
                | "--edit-description"
                | "--set-upstream-to"
                | "--unset-upstream"
                | "--create-reflog"
                | "--track"
                | "--no-track"
                | "--recurse-submodules"
        ) || token.starts_with("--set-upstream-to=")
            || token.starts_with("--track=")
    }) {
        return OpClass::GitWrite;
    }
    if args.is_empty()
        || args.iter().any(|token| matches!(*token, "-l" | "--list" | "--show-current"))
        || args.iter().all(|token| {
            matches!(
                *token,
                "-a" | "--all" | "-r" | "--remotes" | "-v" | "-vv" | "--verbose"
                    | "--no-color" | "--no-column"
            ) || token.starts_with("--color=")
                || token.starts_with("--sort=")
                || token.starts_with("--format=")
        })
    {
        OpClass::GitRead
    } else {
        OpClass::GitWrite
    }
}

/// Check if the command has output redirect operators (`>` or `>>`).
/// Excludes redirects inside quotes and `2>` (stderr redirect).
fn has_output_redirect(command: &str) -> bool {
    let mut chars = command.chars().peekable();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut prev_char = ' ';

    while let Some(ch) = chars.next() {
        if ch == '\'' && !in_double_quote {
            in_single_quote = !in_single_quote;
            prev_char = ch;
            continue;
        }
        if ch == '"' && !in_single_quote {
            in_double_quote = !in_double_quote;
            prev_char = ch;
            continue;
        }
        if in_single_quote || in_double_quote {
            prev_char = ch;
            continue;
        }

        if ch == '>' && prev_char != '2' && prev_char != '\\' {
            // This is stdout redirect (possibly >> as well)
            // Check it's not inside a heredoc marker detection
            // But redirect to a file is a write
            return true;
        }

        // Heredoc: << 'EOF' or <<EOF with a redirect target earlier
        // Pattern: command > file << 'EOF' ... EOF
        // The > is caught above. For << without >, it's stdin to a command, not a file write.
        // We only flag heredocs when combined with > (already caught).

        prev_char = ch;
    }

    false
}

fn truncate_command(cmd: &str) -> String {
    if cmd.len() > 60 {
        format!("{}...", &cmd[..57])
    } else {
        cmd.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- classify() tests ---

    #[test]
    fn cat_file_is_file_read() {
        let classes = classify("cat src/main.rs");
        assert!(classes.contains(&OpClass::FileRead));
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn cat_redirect_is_file_write() {
        let classes = classify("cat > file.rs << 'EOF'\nsome content\nEOF");
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn echo_redirect_is_file_write() {
        let classes = classify("echo 'hello' > output.txt");
        assert!(classes.contains(&OpClass::SafeOutput));
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn compound_command_with_redirect_preserves_opaque_effect() {
        let classes = classify("(rm -rf /private/victim) >receipt.txt");
        assert!(classes.contains(&OpClass::Opaque));
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn append_redirect_is_file_write() {
        let classes = classify("echo 'hello' >> output.txt");
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn grep_is_content_search() {
        let classes = classify("grep -r 'pattern' .");
        assert!(classes.contains(&OpClass::ContentSearch));
    }

    #[test]
    fn rg_is_content_search() {
        let classes = classify("rg 'TODO' src/");
        assert!(classes.contains(&OpClass::ContentSearch));
    }

    #[test]
    fn find_is_file_search() {
        let classes = classify("find . -name '*.rs'");
        assert!(classes.contains(&OpClass::FileSearch));
    }

    #[test]
    fn find_actions_are_not_read_operations() {
        assert!(classify("find . -delete").contains(&OpClass::Destructive));
        assert!(classify("find . -exec touch marker \\;").contains(&OpClass::Destructive));
        assert!(classify("find . '-exec' touch marker \\;").contains(&OpClass::Destructive));
        assert!(readonly_capabilities("find . '-exec' touch marker \\;").is_none());
        assert!(classify("find . -fprintf result.txt '%p\\n'").contains(&OpClass::Destructive));
    }

    #[test]
    fn fd_is_file_search() {
        let classes = classify("fd '*.rs'");
        assert!(classes.contains(&OpClass::FileSearch));
        assert!(classify("fd -x touch marker").contains(&OpClass::Destructive));
        assert!(classify("fd '--exec' touch marker").contains(&OpClass::Destructive));
        assert!(readonly_capabilities("fd -X touch marker").is_none());
        assert!(classify("fd -HIx echo {}").contains(&OpClass::Destructive));
        assert!(readonly_capabilities("fd -HIx echo {}").is_none());
    }

    #[test]
    fn sed_inplace_is_file_modify() {
        let classes = classify("sed -i 's/old/new/' file.rs");
        assert!(classes.contains(&OpClass::FileModify));
    }

    #[test]
    fn sed_without_inplace_is_passthrough() {
        let classes = classify("sed 's/old/new/' file.rs");
        assert!(classes.contains(&OpClass::Passthrough));
    }

    #[test]
    fn sed_print_only_viewers_are_file_reads() {
        for command in [
            "sed -n '1,360p' README.md",
            "sed --quiet '$p' README.md",
            "sed --silent -e '12p' -- -leading-name.md",
            "sed -n '1,360p' first.md && sed -n '1,360p' second.md",
        ] {
            assert!(classify(command).contains(&OpClass::FileRead), "{command}");
            assert_eq!(readonly_capabilities(command), Some(vec!["Read"]), "{command}");
        }
    }

    #[test]
    fn sed_write_execute_and_ambiguous_forms_do_not_borrow_read() {
        for command in [
            "sed -n '1,12w output.txt' README.md",
            "sed -n 's/x/y/p' README.md",
            "sed -f viewer.sed README.md",
            "sed -n -e '1,12p'",
            "sed -n '1,12p' -leading-name.md",
        ] {
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
        for command in [
            "sed -ni '1,12p' README.md",
            "sed --in-place 's/x/y/' README.md",
            "sed --in-place=.bak 's/x/y/' README.md",
        ] {
            assert!(classify(command).contains(&OpClass::FileModify), "{command}");
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
    }

    #[test]
    fn rm_is_destructive() {
        let classes = classify("rm -rf target/");
        assert!(classes.contains(&OpClass::Destructive));
    }

    #[test]
    fn echo_expansion_is_passthrough() {
        let classes = classify("echo $PATH");
        assert!(classes.contains(&OpClass::Passthrough));
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn pwd_is_passthrough() {
        let classes = classify("pwd");
        assert_eq!(classes, vec![OpClass::Passthrough]);
    }

    #[test]
    fn git_log_is_git_read() {
        let classes = classify("git log --oneline");
        assert!(classes.contains(&OpClass::GitRead));
    }

    #[test]
    fn git_status_is_git_read() {
        let classes = classify("git status");
        assert!(classes.contains(&OpClass::GitRead));
    }

    #[test]
    fn git_push_is_git_write() {
        let classes = classify("git push origin main");
        assert!(classes.contains(&OpClass::GitWrite));
    }

    #[test]
    fn git_read_lookalikes_with_mutating_flags_are_git_writes() {
        assert!(classify("git branch feature").contains(&OpClass::GitWrite));
        assert!(classify("git tag v1").contains(&OpClass::GitWrite));
        assert!(classify("git branch -d old").contains(&OpClass::GitWrite));
        assert!(classify("git tag -d v1").contains(&OpClass::GitWrite));
        assert!(classify("git stash").contains(&OpClass::GitWrite));
        assert!(classify("git stash list").contains(&OpClass::GitRead));
        assert!(classify("git branch --list 'feature*'").contains(&OpClass::GitRead));
        assert!(classify("git tag --list 'v*'").contains(&OpClass::GitRead));
    }

    #[test]
    fn git_worktree_effects_are_classified_by_action() {
        for command in ["git worktree", "git worktree list", "git worktree list --porcelain"] {
            assert!(classify(command).contains(&OpClass::GitRead), "{command}");
        }
        for command in [
            "git worktree add /private/worktree main",
            "git worktree lock /private/worktree",
            "git worktree move /private/old /private/new",
            "git worktree repair /private/worktree",
            "git worktree unlock /private/worktree",
        ] {
            assert!(classify(command).contains(&OpClass::LocalWrite), "{command}");
        }
        assert!(classify("git worktree prune --expire now").contains(&OpClass::Destructive));
        assert!(classify("git worktree remove /private/worktree").contains(&OpClass::Destructive));
        for command in [
            "git worktree add \"$(rm -rf /private/victim)\" main",
            "git worktree add \"$(curl https://example.invalid)\" main",
            "git worktree add `opaque-helper` main",
        ] {
            assert_eq!(classify(command), vec![OpClass::Opaque], "{command}");
        }
        for command in [
            "git worktree add \"$(rm -rf /private/victim)\" main >receipt.txt",
            "git worktree add /private/worktree main >\"$(rm -rf /private/victim)\"",
            "git p{u..u}sh origin main >receipt.txt",
            "git worktree rem{o..o}ve --force /private/worktree >receipt.txt",
        ] {
            let classes = classify(command);
            assert!(classes.contains(&OpClass::Opaque), "{command}");
            assert!(classes.contains(&OpClass::FileWrite), "{command}");
        }
        for command in [
            "git worktree add <(rm -rf /private/victim) main",
            "git worktree add >(rm -rf /private/victim) main",
        ] {
            assert!(classify(command).contains(&OpClass::Opaque), "{command}");
        }
        for command in [
            "git worktree remove --force /private/worktree >receipt.txt",
            "git worktree \"remove\" --force /private/worktree >receipt.txt",
            "git worktree re\\move --force /private/worktree >receipt.txt",
            "git worktree prune --expire now >receipt.txt",
            "git clean -fd >receipt.txt",
        ] {
            assert!(classify(command).contains(&OpClass::Destructive), "{command}");
        }
        assert!(classify("git push origin main >receipt.txt").contains(&OpClass::GitWrite));
        assert!(classify("git \"push\" origin main >receipt.txt").contains(&OpClass::GitWrite));
        assert!(classify("git pu\\sh origin main >receipt.txt").contains(&OpClass::GitWrite));
        assert!(classify("git > receipt.txt \"push\" origin main").contains(&OpClass::GitWrite));
        assert!(classify("git rev-parse HEAD").contains(&OpClass::GitRead));
        assert!(classify("git branch --all --no-color").contains(&OpClass::GitRead));
        assert_eq!(classify("git worktree opaque"), vec![OpClass::Passthrough]);
        assert_eq!(classify("/tmp/git worktree add /private/worktree main"), vec![OpClass::Passthrough]);
        for command in [
            "git -C worktree add /private/worktree main",
            "git -c worktree list",
            "git --git-dir worktree list",
            "git --config-env worktree list",
        ] {
            assert_eq!(classify(command), vec![OpClass::Passthrough], "{command}");
        }
    }

    #[test]
    fn git_commit_is_git_write() {
        let classes = classify("git commit -m 'fix bug'");
        assert!(classes.contains(&OpClass::GitWrite));
    }

    #[test]
    fn git_checkout_branch_is_git_read() {
        let classes = classify("git checkout feature-branch");
        assert!(classes.contains(&OpClass::GitRead));
    }

    #[test]
    fn git_checkout_file_is_git_write() {
        let classes = classify("git checkout -- src/main.rs");
        assert!(classes.contains(&OpClass::GitWrite));
    }

    #[test]
    fn curl_is_network() {
        let classes = classify("curl https://example.com");
        assert!(classes.contains(&OpClass::Network));
    }

    #[test]
    fn wget_is_network() {
        let classes = classify("wget https://example.com/file.tar.gz");
        assert!(classes.contains(&OpClass::Network));
    }

    #[test]
    fn tee_is_file_write() {
        let classes = classify("echo hello | tee output.txt");
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn cargo_test_is_passthrough() {
        let classes = classify("cargo test");
        assert!(classes.contains(&OpClass::Passthrough));
    }

    #[test]
    fn pytest_is_passthrough() {
        let classes = classify("pytest -x tests/");
        assert!(classes.contains(&OpClass::Passthrough));
    }

    #[test]
    fn npm_test_is_passthrough() {
        let classes = classify("npm test");
        assert!(classes.contains(&OpClass::Passthrough));
    }

    #[test]
    fn cp_is_file_write() {
        let classes = classify("cp src.rs dst.rs");
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn mv_is_file_write() {
        let classes = classify("mv old.rs new.rs");
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn patch_is_file_modify() {
        let classes = classify("patch -p1 < fix.patch");
        assert!(classes.contains(&OpClass::FileModify));
    }

    #[test]
    fn git_clean_is_destructive() {
        let classes = classify("git clean -fd");
        assert!(classes.contains(&OpClass::Destructive));
    }

    #[test]
    fn ls_is_passthrough() {
        let classes = classify("ls -la");
        assert_eq!(classes, vec![OpClass::Passthrough]);
    }

    // --- Piped / chained command tests ---

    #[test]
    fn pipe_cat_grep_redirect_classifies_all_three() {
        let classes = classify("cat file.rs | grep pattern > output.txt");
        assert!(classes.contains(&OpClass::FileRead));
        assert!(classes.contains(&OpClass::ContentSearch));
        assert!(classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn chained_git_status_and_sed_inplace() {
        let classes = classify("git status && sed -i 's/x/y/' file.rs");
        assert!(classes.contains(&OpClass::GitRead));
        assert!(classes.contains(&OpClass::FileModify));
    }

    #[test]
    fn semicolon_separated() {
        let classes = classify("echo hello; rm temp.txt");
        assert!(classes.contains(&OpClass::SafeOutput));
        assert!(classes.contains(&OpClass::Destructive));
    }

    // --- Redirect edge cases ---

    #[test]
    fn stderr_redirect_not_file_write() {
        let classes = classify("cargo test 2>/dev/null");
        // 2> is stderr redirect, should NOT trigger FileWrite
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn redirect_in_single_quotes_not_file_write() {
        let classes = classify("echo '> not a redirect'");
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn redirect_in_double_quotes_not_file_write() {
        let classes = classify("echo \"> not a redirect\"");
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    // --- check_against_allowed() tests ---

    #[test]
    fn cat_allowed_when_read_in_tools() {
        let allowed = vec!["Read".into()];
        assert!(check_against_allowed("cat src/main.rs", &allowed).is_ok());
    }

    #[test]
    fn search_and_glob_are_allowed_with_read() {
        let allowed = vec!["Read".into()];
        assert!(check_against_allowed("rg needle src", &allowed).is_ok());
        assert!(check_against_allowed("find src -name '*.rs'", &allowed).is_ok());
    }

    #[test]
    fn cat_redirect_blocked_when_write_not_in_tools() {
        let allowed = vec!["Read".into()];
        let result = check_against_allowed("cat > file.rs << 'EOF'\ncontent\nEOF", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("FileWrite"));
    }

    #[test]
    fn cat_redirect_allowed_when_write_in_tools() {
        let allowed = vec!["Read".into(), "Write".into()];
        assert!(check_against_allowed("cat > file.rs << 'EOF'\ncontent\nEOF", &allowed).is_ok());
    }

    #[test]
    fn rm_always_blocked_in_restricted_state() {
        let allowed = vec!["Read".into(), "Write".into(), "Bash".into()];
        let result = check_against_allowed("rm -rf /", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Destructive"));
    }

    #[test]
    fn git_push_blocked_in_restricted_state() {
        let allowed = vec!["Read".into(), "Bash".into()];
        let result = check_against_allowed("git push origin main", &allowed);
        assert!(result.is_err());
    }

    #[test]
    fn cargo_test_allowed_with_just_bash() {
        let allowed = vec!["Bash".into()];
        assert!(check_against_allowed("cargo test", &allowed).is_ok());
    }

    #[test]
    fn sed_inplace_blocked_without_edit() {
        let allowed = vec!["Read".into(), "Bash".into()];
        let result = check_against_allowed("sed -i 's/old/new/' file.rs", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("FileModify"));
    }

    #[test]
    fn sed_inplace_allowed_with_write() {
        let allowed = vec!["Read".into(), "Bash".into(), "Write".into()];
        assert!(check_against_allowed("sed -i 's/old/new/' file.rs", &allowed).is_ok());
    }

    #[test]
    fn piped_command_all_classes_must_be_allowed() {
        // cat (Read) | grep (Grep) > output.txt (Write)
        // With only Read + Grep, the redirect to file should be blocked
        let allowed = vec!["Read".into(), "Grep".into()];
        let result = check_against_allowed("cat file.rs | grep pattern > output.txt", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("FileWrite"));
    }

    #[test]
    fn piped_command_allowed_when_all_tools_present() {
        let allowed = vec!["Read".into(), "Grep".into(), "Write".into()];
        assert!(check_against_allowed("cat file.rs | grep pattern > output.txt", &allowed).is_ok());
    }

    // --- Env var prefix handling ---

    #[test]
    fn env_var_prefix_stripped() {
        let classes = classify("FOO=bar grep 'pattern' .");
        assert!(classes.contains(&OpClass::ContentSearch));
    }

    #[test]
    fn path_prefix_stripped() {
        let classes = classify("/usr/bin/grep 'pattern' .");
        assert!(classes.contains(&OpClass::ContentSearch));
    }

    #[test]
    fn heredoc_to_command_stdin_is_not_file_write() {
        // psql << 'SQL' ... SQL — heredoc as stdin to a command, not writing to a file
        // No > redirect, so this should NOT be FileWrite
        let classes = classify("psql << 'SQL'\nSELECT 1;\nSQL");
        assert!(!classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn allowed_command_matches_only_a_simple_token_prefix() {
        assert!(matches_allowed_command(
            "cargo test -p statewright-engine",
            "cargo test"
        ));
        assert!(matches_allowed_command(
            "node --test 'tests/smoke test.mjs'",
            "node --test"
        ));
        assert!(!matches_allowed_command(
            "cargo test; kubectl apply -f pod.yaml",
            "cargo test"
        ));
        assert!(!matches_allowed_command(
            "cargo test $(kubectl config view)",
            "cargo test"
        ));
        assert!(!matches_allowed_command("cargo testbed", "cargo test"));
    }

    #[test]
    fn allowed_task_namespace_is_bounded_to_one_test_task() {
        for command in [
            "task test:unit",
            "task test:unit -- --runInBand",
            "task test:pocketbase:migrations DATABASE=isolated",
        ] {
            assert!(
                matches_allowed_command(command, "task test:*"),
                "should allow test namespace command: {command}"
            );
        }

        for command in [
            "task test",
            "task test:",
            "task testing:unit",
            "task deploy",
            "task test:unit; node exploit.mjs",
            "task test:unit && task deploy",
            "task test:unit $(node exploit.mjs)",
            "task test:unit > receipt.txt",
        ] {
            assert!(
                !matches_allowed_command(command, "task test:*"),
                "should reject command outside the bounded test namespace: {command}"
            );
        }
    }

    #[test]
    fn readonly_checksums_require_narrow_generation_arguments() {
        for command in [
            "sha256sum receipt.json",
            "sha256sum -- receipt.json ./second.json",
            "sha256sum \"path with spaces/receipt.json\"",
            "sha256sum 'path with spaces/receipt.json'",
            "/usr/bin/shasum -a 256 /tmp/receipt.json",
            "shasum -a 256 -- receipt.json ./second.json",
            "shasum -a 256 receipt.json | head -n 1",
        ] {
            assert_eq!(readonly_capabilities(command), Some(vec!["Read"]), "{command}");
        }
        for command in [
            "sha256sum", "sha256sum -", "sha256sum --",
            "sha256sum --check receipt.sha256", "sha256sum -c receipt.sha256",
            "sha256sum --binary receipt.json", "sha256sum receipt.json --help",
            "shasum receipt.json", "shasum -a 512 receipt.json", "shasum -a 256",
            "shasum -a 256 --check receipt.sha256",
            "sha256sum receipt.json > receipt.sha256",
            "sha256sum receipt.json; touch marker",
            "sha256sum receipt.json & touch marker",
            "sha256sum $(touch marker)", "sha256sum `touch marker`",
            "sha256sum \"$RECEIPT\"", "sha256sum *.json",
            "sha256sum \"unterminated",
            "openssl dgst -sha256 receipt.json", "python3 -c 'print(1)'",
        ] {
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
    }

    #[test]
    fn readonly_capabilities_reuse_command_classification_without_bash_escalation() {
        assert_eq!(
            readonly_capabilities("sed -n '1,12p' README.md"),
            Some(vec!["Read"]),
        );
        assert_eq!(
            readonly_capabilities("cat README.md | rg Statewright"),
            Some(vec!["Grep", "Read"]),
        );
        assert_eq!(readonly_capabilities("printf x > marker.txt"), None);
        assert_eq!(readonly_capabilities("python3 -c 'print(1)'"), None);
        assert_eq!(readonly_capabilities("rm marker.txt"), None);
        assert_eq!(readonly_capabilities("awk 'BEGIN { system(\"touch marker\") }'"), None);
        assert_eq!(readonly_capabilities("git branch feature"), None);
        assert_eq!(readonly_capabilities("git tag v1"), None);
        assert_eq!(readonly_capabilities("git rev-parse HEAD"), Some(vec!["Read"]));
        assert_eq!(
            readonly_capabilities("git branch --all --no-color"),
            Some(vec!["Read"]),
        );
        assert_eq!(readonly_capabilities("rg --pre /bin/cat needle README.md"), None);
        assert_eq!(readonly_capabilities("ripgrep --pre=/bin/cat needle README.md"), None);
    }

    #[test]
    fn readonly_shell_predicates_are_bounded_builtins() {
        assert_eq!(
            readonly_capabilities("test ! -e /private/worktree"),
            Some(vec!["Read"]),
        );
        assert_eq!(
            readonly_capabilities("[ -f README.md ]"),
            Some(vec!["Read"]),
        );
        assert_eq!(readonly_capabilities("test -v SAFE_NAME"), Some(vec!["Read"]));
        for command in [
            "test",
            "[ -f README.md",
            "/tmp/test ! -e /private/worktree",
            "/tmp/[ -f README.md ]",
            "test -v 'BASH_ARGV[i=7]'",
            "[ -v 'BASH_ARGV[i++]' ]",
            "test left -a right",
            "test ! -e /private/worktree && touch marker",
            "test \"$(touch marker)\"",
        ] {
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
    }

    #[test]
    fn readonly_discovery_may_discard_stderr_only_to_dev_null() {
        let command = "rg --files -g '*oauth*' -g '*receipt*' . /private/statewright 2>/dev/null | sed -n '1,240p'";
        assert_eq!(readonly_capabilities(command), Some(vec!["Grep", "Read"]));
        assert_eq!(readonly_capabilities("sed -n '1,20p'"), Some(vec!["Read"]));

        for unsafe_command in [
            "rg --files 2>receipt.txt",
            "rg --files 2>>/dev/null",
            "rg --files 2>/dev/null/path",
            "rg --files 3>/dev/null",
            "rg --files 2>&1",
            "rg --files 2>/dev/null && touch marker",
            "/tmp/sed -n '1,20p'",
        ] {
            assert_eq!(readonly_capabilities(unsafe_command), None, "{unsafe_command}");
        }
    }

    #[test]
    fn stdout_only_labels_compose_with_bounded_reads() {
        let command = "sed -n '1,300p' /private/agentic-sdlc/SKILL.md && printf '\\n--- optimize usage ---\\n' && sed -n '1,300p' /private/optimize-statewright-usage/SKILL.md";
        assert_eq!(readonly_capabilities(command), Some(vec!["Read"]));

        for unsafe_command in [
            "printf '%s' \"$(touch marker)\"",
            "printf -v PATH /attacker",
            "printf -vPATH ignored",
            "printf '%n' PATH",
            "/tmp/printf label",
            "/tmp/echo label",
            "printf label > marker.txt",
            "echo label >> marker.txt",
            "echo `touch marker`",
        ] {
            assert_eq!(readonly_capabilities(unsafe_command), None, "{unsafe_command}");
        }
    }

    #[test]
    fn tmux_reads_are_deterministic_but_executable_formats_are_not() {
        for command in [
            "tmux capture-pane -p -t %36 -S -80 | tail -80",
            "tmux list-panes -a -F '#{pane_id} #{pane_title}'",
            "tmux list-sessions",
            "tmux has-session -t weekly-top5",
            "tmux display-message -p '#{session_name}'",
            "tmux show-options -g status",
        ] {
            assert!(readonly_capabilities(command).is_some(), "{command}");
        }
        for command in [
            "tmux capture-pane -t %36",
            "tmux display-message hello",
            "tmux list-panes -F '#(touch /tmp/marker)'",
            "tmux send-keys -t %36 status Enter",
            "tmux new-session shell",
        ] {
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
    }

    #[test]
    fn only_one_complete_goal_dispatch_is_a_local_write() {
        for command in [
            "tmux send-keys -t %36 '/goal finish the OAuth boundary' Enter",
            "tmux send-keys -t %1 '/goal validate the staged canary' C-m",
        ] {
            assert_eq!(classify(command), vec![OpClass::LocalWrite], "{command}");
        }
        for command in [
            "tmux send-keys -t pane-name '/goal unsafe target' Enter",
            "tmux send-keys -t %36 status Enter",
            "tmux send-keys -t %36 '/goal ' Enter",
            "tmux send-keys -t %36 '/goal work' Enter extra",
            "tmux send-keys -t %36 '/goal work' Enter; opaque-wrapper",
        ] {
            assert!(!classify(command).contains(&OpClass::LocalWrite), "{command}");
        }
    }

    #[test]
    fn readonly_git_admission_rejects_mutators_and_output_writes() {
        for command in [
            "git switch -c feature",
            "git restore tracked.txt",
            "git checkout main",
            "git diff --output=review.patch",
            "git diff --output review.patch",
            "git diff",
            "git log --oneline",
            "git show HEAD",
            "git diff --textconv",
            "git show --textconv HEAD:README.md",
            "git --no-pager log --no-ext-diff --no-textconv --show-signature",
            "git --no-pager log --no-ext-diff --no-textconv --oneline",
            "git --no-pager show --no-ext-diff --no-textconv HEAD",
            "git --no-pager reflog show",
            "git --no-pager stash list",
            "git --no-pager stash show",
            "git --no-pager diff --no-ext-diff -- --no-textconv",
            "/tmp/git --no-pager diff --no-ext-diff --no-textconv",
            "git -ccore.fsmonitor=/tmp/helper status",
            "git status",
            "git --no-pager branch -- new-name",
            "git --no-pager tag -- new-name",
            "git --no-pager branch --list --delete",
            "git branch --all --delete old",
            "git branch --list --set-upstream-to=origin/main main",
            "git --no-pager diff --output review.patch --no-ext-diff --no-textconv",
            "git --no-pager diff --no-ext-diff --word-diff --no-textconv",
            "sort -o output.txt input.txt",
            "uniq input.txt output.txt",
            "xxd input.txt output.txt",
            "xxd -r input.hex output.bin",
            "less README.md",
            "more README.md",
            "bat README.md",
            "git add README.md",
            "git stash push",
        ] {
            assert_eq!(readonly_capabilities(command), None, "{command}");
        }
        for command in [
            "git --no-pager diff --no-ext-diff --no-textconv",
            "git --no-pager diff --no-ext-diff --no-textconv -- README.md",
            "git --no-pager branch --list",
            "git --no-pager branch --list feature*",
            "git --no-pager branch --list -- feature*",
            "git --no-pager tag --list",
        ] {
            assert_eq!(readonly_capabilities(command), Some(vec!["Read"]), "{command}");
        }
    }

    #[test]
    fn semantic_shape_preserves_operation_but_redacts_operands_and_values() {
        let shapes = semantic_command_shapes(
            "API_TOKEN=secret tmux capture-pane -p -t %33 -S -80 && git --no-pager status /private/repo",
        ).unwrap();
        assert_eq!(shapes, vec![
            SemanticCommandShape { executable: "tmux".into(), operation: Some("capture-pane".into()), delegates_unknown_effect: false },
            SemanticCommandShape { executable: "git".into(), operation: Some("status".into()), delegates_unknown_effect: false },
        ]);
        let rendered = serde_json::to_string(&shapes).unwrap();
        for secret in ["secret", "%33", "-80", "/private/repo"] { assert!(!rendered.contains(secret)); }
    }

    #[test]
    fn semantic_shape_labels_only_proven_sed_viewers() {
        let shapes = semantic_command_shapes(
            "sed -n '1,360p' /private/first && sed --quiet '$p' /private/second",
        )
        .unwrap();
        assert_eq!(
            shapes,
            vec![
                SemanticCommandShape {
                    executable: "sed".into(),
                    operation: Some("print".into()),
                    delegates_unknown_effect: false,
                },
                SemanticCommandShape {
                    executable: "sed".into(),
                    operation: Some("print".into()),
                    delegates_unknown_effect: false,
                },
            ]
        );
        let rendered = serde_json::to_string(&shapes).unwrap();
        for private in ["1,360p", "/private/first", "$p", "/private/second"] {
            assert!(!rendered.contains(private), "{private}");
        }

        let ambiguous = semantic_command_shapes("sed -n 's/x/y/p' /private/input").unwrap();
        assert_eq!(ambiguous[0].operation, None);
    }

    #[test]
    fn semantic_shape_omits_unknown_arguments_and_rejects_expansion() {
        let shape = semantic_command_shapes("opaque-wrapper private-token").unwrap();
        assert_eq!(shape[0].executable, "opaque-wrapper");
        assert!(shape[0].operation.is_none());
        assert!(semantic_command_shapes("tmux $(secret-helper)").is_none());
    }

    #[test]
    fn semantic_shape_never_promotes_option_values_to_operations() {
        for (command, secret) in [
            ("tmux -L privateSocket capture-pane -p", "privateSocket"),
            ("git -C secretProject status", "secretProject"),
            ("git --git-dir --private-client-token status", "--private-client-token"),
            ("tmux -L --privateSocket capture-pane", "--privateSocket"),
        ] {
            let shape = semantic_command_shapes(command).unwrap();
            assert!(shape[0].operation.is_none(), "{command}");
            assert!(!serde_json::to_string(&shape).unwrap().contains(secret), "{command}");
        }
        let task = semantic_command_shapes("task private-client-token").unwrap();
        assert!(task[0].operation.is_none());
        assert!(task[0].delegates_unknown_effect);
        assert!(!serde_json::to_string(&task).unwrap().contains("private-client-token"));

        for command in ["npm test", "pnpm lint", "cargo test", "docker exec container id", "kubectl exec pod -- id", "tmux new-session shell"] {
            assert!(semantic_command_shapes(command).unwrap()[0].delegates_unknown_effect, "{command}");
        }
    }

    #[test]
    fn blocked_environment_references_use_exact_identifier_boundaries() {
        for command in [
            "TOKEN=value command", "env TOKEN=value command", "echo $TOKEN",
            "echo ${TOKEN}", "echo ${TOKEN:-fallback}", "echo x$TOKEN/path",
        ] {
            assert!(references_environment_variable(command, "TOKEN"), "{command}");
        }
        for command in ["echo $TOKEN_SUFFIX", "TOKEN_SUFFIX=value command", "echo ordinary"] {
            assert!(!references_environment_variable(command, "TOKEN"), "{command}");
        }
        assert!(!references_environment_variable("echo $TOKEN", "TOKEN-NOT-A-NAME"));
    }
}
