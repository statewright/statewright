//! Bash command classifier for guardrail enforcement.
//!
//! Classifies shell commands by operation type (file write, file read, destructive, etc.)
//! so that per-state tool restrictions extend to Bash commands. Without this, an agent
//! can bypass `Write` restrictions by using `cat > file << 'EOF'` through the `Bash` tool.

/// Operation class for a shell command segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpClass {
    /// Writing new content to a file (requires Write or Edit).
    FileWrite,
    /// Modifying a file in-place (requires Edit).
    FileModify,
    /// Reading file contents (requires Read).
    FileRead,
    /// Searching file contents (requires Grep).
    ContentSearch,
    /// Searching for files by name/path (requires Glob).
    FileSearch,
    /// Destructive operations — always blocked in restricted states.
    Destructive,
    /// Network operations (requires WebFetch or explicit allowance).
    Network,
    /// Git write operations (requires explicit allowance).
    GitWrite,
    /// Git read operations (requires Read).
    GitRead,
    /// Benign or unclassifiable — allowed if Bash itself is allowed.
    Passthrough,
}

impl OpClass {
    /// Returns the tool names required in `allowed_tools` for this operation class.
    /// Returns an empty slice for Passthrough (always allowed if Bash is).
    /// Returns `&["__BLOCKED__"]` for operations that require an explicit approval gate.
    pub fn required_tools(&self) -> &'static [&'static str] {
        match self {
            OpClass::FileWrite => &["Write", "Edit"],
            OpClass::FileModify => &["Edit"],
            OpClass::FileRead => &["Read"],
            OpClass::ContentSearch => &["Grep"],
            OpClass::FileSearch => &["Glob"],
            OpClass::Destructive => &["__DESTRUCTIVE__"],
            OpClass::Network => &["WebFetch"],
            OpClass::GitWrite => &["__GIT_WRITE__"],
            OpClass::GitRead => &["Read"],
            OpClass::Passthrough => &[],
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
            allowed_tools.iter().any(|allowed| allowed.eq_ignore_ascii_case(req))
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

// --- Internal helpers ---

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
    let cmd_idx = tokens.iter().position(|t| !t.contains('=') || t.starts_with('-'));
    let base_cmd = match cmd_idx {
        Some(idx) => tokens[idx],
        None => return OpClass::Passthrough,
    };

    // Strip path prefix: /usr/bin/grep → grep
    let base_cmd = base_cmd.rsplit('/').next().unwrap_or(base_cmd);

    match base_cmd {
        // File read commands
        "cat" | "head" | "tail" | "less" | "more" | "bat" | "xxd" => {
            // cat with redirect is FileWrite — handled by has_output_redirect
            OpClass::FileRead
        }

        // Content search
        "grep" | "rg" | "ag" | "ack" | "ripgrep" => OpClass::ContentSearch,

        // File search
        "find" | "fd" | "locate" | "mdfind" => OpClass::FileSearch,

        // File modify (in-place)
        "sed" => {
            if tokens.iter().any(|t| *t == "-i" || t.starts_with("-i")) {
                OpClass::FileModify
            } else {
                OpClass::Passthrough
            }
        }
        "awk" | "gawk" => {
            if tokens.iter().any(|t| *t == "-i" && tokens.iter().any(|t2| *t2 == "inplace")) {
                OpClass::FileModify
            } else {
                OpClass::Passthrough
            }
        }
        "perl" => {
            if tokens.iter().any(|t| *t == "-pi" || *t == "-p" || *t == "-i") {
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
        "git" => classify_git(&tokens),

        // Everything else
        _ => OpClass::Passthrough,
    }
}

/// Classify a git command by its subcommand.
fn classify_git(tokens: &[&str]) -> OpClass {
    // Find the git subcommand (skip flags like -C, -c)
    let subcmd = tokens.iter().skip(1).find(|t| !t.starts_with('-'));

    match subcmd.map(|s| *s) {
        Some("log") | Some("status") | Some("diff") | Some("blame") | Some("show")
        | Some("branch") | Some("tag") | Some("stash") | Some("reflog") => OpClass::GitRead,

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
    fn fd_is_file_search() {
        let classes = classify("fd '*.rs'");
        assert!(classes.contains(&OpClass::FileSearch));
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
    fn rm_is_destructive() {
        let classes = classify("rm -rf target/");
        assert!(classes.contains(&OpClass::Destructive));
    }

    #[test]
    fn echo_path_is_passthrough() {
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
        assert!(classes.contains(&OpClass::Passthrough));
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
        let allowed = vec!["Read".into(), "Grep".into(), "Glob".into()];
        assert!(check_against_allowed("cat src/main.rs", &allowed).is_ok());
    }

    #[test]
    fn cat_redirect_blocked_when_write_not_in_tools() {
        let allowed = vec!["Read".into(), "Grep".into(), "Glob".into()];
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
        let allowed = vec!["Read".into(), "Write".into(), "Edit".into(), "Bash".into()];
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
    fn sed_inplace_allowed_with_edit() {
        let allowed = vec!["Read".into(), "Bash".into(), "Edit".into()];
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
}
