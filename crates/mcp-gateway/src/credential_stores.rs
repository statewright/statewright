//! Known-risk credential stores. An agent that can read the credential Claude
//! uses for the Statewright MCP connection can act as the plugin at the gateway
//! (see docs: "Known risks"). Reads of those stores are therefore never treated
//! as merely uncertain: they are denied without a classifier review request, so
//! no human prompt can be steered into approving them.
//!
//! This is a best-effort screen over every string in the tool input. Before
//! matching, each string is normalised the way a shell would read it: quotes
//! and backslash escapes are removed, and `~`, `$HOME`, `${HOME}` and literal
//! home directories become `~`. A glob that could match a credential store
//! counts as a reference, and so does naming a credential directory itself
//! (`cp -r ~/.claude /tmp/x`). It still cannot see through arbitrary
//! obfuscation (variables, string building in scripts); it closes the
//! obvious routes and keeps them out of the timed-approval flow.
use serde_json::Value;

const MARKERS: &[&str] = &[
    // macOS Keychain: Claude Code stores MCP OAuth credentials here.
    "find-generic-password",
    "find-internet-password",
    "dump-keychain",
    "export-keychain",
    "claude code-credentials",
    "login.keychain",
    // Linux/WSL Claude Code credential file and libsecret.
    ".credentials.json",
    "secret-tool lookup",
    "secret-tool search",
    // Statewright's own stored keys.
    "ai.statewright.gateway",
    ".statewright/api_key",
    ".statewright/staging_api_key",
    // The managed bridge token file (a 0600 file in the supervisor's control dir).
    "managed-mcp.token",
];

/// Credential store paths, relative to the home directory or to a control
/// directory. A glob is a reference when it could match one of these.
const CREDENTIAL_PATHS: &[&str] = &[
    ".claude/.credentials.json",
    ".statewright/api_key",
    ".statewright/staging_api_key",
    // Example control directories (mkdtemp `statewright-<host>-route-XXXXXX`).
    "statewright-claude-route-x/managed-mcp.token",
    "statewright-codex-route-x/managed-mcp.token",
];
/// Credential file names a relative dot-file glob (`.cred*`) could reach.
const CREDENTIAL_FILES: &[&str] = &[".credentials.json"];
/// Directories whose wholesale copy or recursive read exposes a store.
const CREDENTIAL_DIRS: &[&str] = &["~/.claude", "~/.statewright"];

fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

/// Remove shell quoting (`'`, `"`, `\`), canonicalise home references to
/// `~`, and lowercase. `fi""nd-generic-password` and `.j''son` both read as
/// their unquoted words.
fn normalise(text: &str) -> String {
    let unquoted: String = text
        .chars()
        .filter(|c| !matches!(c, '\'' | '"' | '\\'))
        .collect::<String>()
        .to_ascii_lowercase();
    let mut out = unquoted.replace("${home}", "~").replace("$home", "~");
    for prefix in ["/users/", "/home/"] {
        while let Some(at) = out.find(prefix) {
            let rest = &out[at + prefix.len()..];
            let user_end = rest.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(rest.len());
            if user_end == 0 {
                break;
            }
            out = format!("{}~{}", &out[..at], &rest[user_end..]);
        }
    }
    if let Some(rest) = out.strip_prefix("/root") {
        if rest.is_empty() || rest.starts_with('/') {
            out = format!("~{rest}");
        }
    }
    out.replace(" /root/", " ~/").replace("//", "/")
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '`' | '=' | ','))
        .filter(|word| !word.is_empty())
}

/// Shell glob match for one path (`*` and `?` do not cross `/`; `[...]`
/// classes; leading dots are matched like any other character, which is
/// the conservative reading for `dotglob`).
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.first() {
        None => text.is_empty(),
        Some(b'*') => {
            let rest = &pattern[1..];
            (0..=text.len())
                .take_while(|&skip| skip == 0 || text[skip - 1] != b'/')
                .any(|skip| glob_match(rest, &text[skip..]))
        }
        Some(b'?') => !text.is_empty() && text[0] != b'/' && glob_match(&pattern[1..], &text[1..]),
        Some(b'[') => {
            let Some(close) = pattern[1..].iter().position(|&c| c == b']').map(|i| i + 1) else {
                return text.first() == Some(&b'[') && glob_match(&pattern[1..], &text[1..]);
            };
            let Some(&c) = text.first() else { return false };
            let class = &pattern[1..close];
            let (negate, class) = match class.first() {
                Some(b'!') | Some(b'^') => (true, &class[1..]),
                _ => (false, class),
            };
            let mut hit = false;
            let mut i = 0;
            while i < class.len() {
                if i + 2 < class.len() && class[i + 1] == b'-' {
                    hit |= class[i] <= c && c <= class[i + 2];
                    i += 3;
                } else {
                    hit |= class[i] == c;
                    i += 1;
                }
            }
            hit != negate && c != b'/' && glob_match(&pattern[close + 1..], &text[1..])
        }
        Some(&c) => text.first() == Some(&c) && glob_match(&pattern[1..], &text[1..]),
    }
}

/// Brace alternatives (`{json,bak}`) are widened to `*`: a superset match.
fn widen_braces(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut depth = 0usize;
    for c in word.chars() {
        match c {
            '{' => {
                if depth == 0 {
                    out.push('*');
                }
                depth += 1;
            }
            '}' if depth > 0 => depth -= 1,
            _ if depth > 0 => {}
            _ => out.push(c),
        }
    }
    out
}

/// True when a word containing glob characters could expand to a credential
/// store path. Bare `*` or `*.json` without a dot-file or directory anchor is
/// not flagged, so ordinary globs stay reviewable.
fn glob_reaches_store(word: &str) -> bool {
    if !word.contains(['*', '?', '[', '{']) {
        return false;
    }
    let word = widen_braces(word);
    let word = word.trim_end_matches('/');
    let bytes = word.as_bytes();
    // Every suffix that starts a path segment, e.g. `~/.claude/.cred*`,
    // `.claude/.cred*` and `.cred*`.
    let mut starts = vec![0];
    starts.extend(bytes.iter().enumerate().filter(|&(_, &c)| c == b'/').map(|(i, _)| i + 1));
    starts.into_iter().filter(|&at| at < bytes.len()).any(|at| {
        let suffix = &bytes[at..];
        if suffix.contains(&b'/') {
            CREDENTIAL_PATHS.iter().any(|path| glob_match(suffix, path.as_bytes()))
        } else {
            // A single segment must anchor on a dot file with a literal
            // character after the dot (`.cred*`, `.c?edentials.json`).
            suffix.len() > 1
                && suffix[0] == b'.'
                && !matches!(suffix[1], b'*' | b'?' | b'[')
                && CREDENTIAL_FILES.iter().any(|file| glob_match(suffix, file.as_bytes()))
        }
    })
}

/// True when a word names a credential directory itself (`~/.claude`,
/// `~/.claude/`, `~/.statewright/.`), which a copy or recursive read would
/// take whole.
fn names_store_dir(word: &str) -> bool {
    let trimmed = word.trim_end_matches("/.").trim_end_matches('/');
    CREDENTIAL_DIRS.contains(&trimmed)
}

fn normalised_references(text: &str) -> bool {
    let normal = normalise(text);
    MARKERS.iter().any(|marker| normal.contains(marker))
        || words(&normal).any(|word| glob_reaches_store(word) || names_store_dir(word))
}

/// True when any string in the tool input references a known credential store.
pub(crate) fn references_credential_store(tool_input: &Value) -> bool {
    let mut found = Vec::new();
    strings(tool_input, &mut found);
    found.iter().any(|text| {
        let lower = text.to_ascii_lowercase();
        MARKERS.iter().any(|marker| lower.contains(marker)) || normalised_references(text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_and_statewright_credential_stores_are_known_risk() {
        for command in [
            "security find-generic-password -s 'Claude Code-credentials' -w",
            "SECURITY Find-Generic-Password -s x",
            "security dump-keychain",
            "cat ~/.claude/.credentials.json",
            "cd ~/.claude && jq . .credentials.json",
            "secret-tool lookup service claude",
            "security find-generic-password -s ai.statewright.gateway",
            "cat ~/.statewright/api_key",
        ] {
            assert!(references_credential_store(&json!({"command":command})), "{command}");
        }
        assert!(references_credential_store(&json!({"file_path":"/Users/x/.claude/.credentials.json"})));
        assert!(references_credential_store(&json!({"args":["-c","cat .credentials.json"]})));
    }

    #[test]
    fn quoting_globs_and_directory_copies_are_known_risk() {
        for command in [
            // Globs that could expand to a credential file.
            "cat ~/.claude/.cred*",
            "cat $HOME/.claude/.c?edentials.json",
            "cat ${HOME}/.claude/.credentials.[j]son",
            "cd ~/.claude && cat .cred*",
            "cat ~/.claude/*",
            "cat ~/.*/.cred*",
            "cat /Users/someone/.claude/.cred*",
            "cat /home/someone/.claude/.cr*",
            "cat ~/.statewright/*key",
            "cat ~/.statewright/api_*",
            "cat ~/.claude/.credentials.{json,bak}",
            "cat /tmp/statewright-claude-route-*/managed-mcp.tok*",
            // Quote-split and escaped names.
            "cat ~/.claude/.credentials.j''son",
            "cat ~/.claude/.cred\"\"entials.json",
            "cat ~/.claude/.cr\\edentials.json",
            "security fi\"\"nd-generic-password -s x -w",
            "cat ~/.state'wright'/api_key",
            // Whole credential directories.
            "cp -r ~/.claude /tmp/x",
            "cp -R ~/.claude/ /tmp/x",
            "rsync -a $HOME/.claude/ backup/",
            "tar czf out.tgz ~/.statewright",
            "zip -r out.zip /Users/someone/.claude",
            "cp -r \"$HOME/.claude\" /tmp/x",
        ] {
            assert!(references_credential_store(&json!({"command":command})), "{command}");
        }
        assert!(references_credential_store(&json!({"args":["-r","~/.claude","/tmp/x"]})));
        assert!(references_credential_store(&json!({"path":"/Users/x/.claude","pattern":"token"})));
    }

    #[test]
    fn ordinary_globs_and_claude_subpaths_stay_reviewable() {
        for command in [
            "ls *.json",
            "cat *",
            "rm -f build/*.o",
            "ls ~/.claude/plugins",
            "ls ~/.claude/plugins/*",
            "cat ~/.claude/settings.json",
            "cp -r ~/.claude/plugins/cache/x /tmp/x",
            "cat ~/.claudex/notes",
            "echo {a,b}",
            "git log --format=%h",
            "cat ~/.statewright/sessions/abc/.state_cache",
        ] {
            assert!(!references_credential_store(&json!({"command":command})), "{command}");
        }
    }

    #[test]
    fn ordinary_commands_are_not_flagged() {
        for command in ["cargo test", "cat README.md", "security --help", "ls ~/.claude/plugins"] {
            assert!(!references_credential_store(&json!({"command":command})), "{command}");
        }
    }
}
