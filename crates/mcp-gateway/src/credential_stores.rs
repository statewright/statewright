//! Known-risk credential stores. An agent that can read the credential Claude
//! uses for the Statewright MCP connection can act as the plugin at the gateway
//! (see docs: "Known risks"). Reads of those stores are therefore never treated
//! as merely uncertain: they are denied without a classifier review request, so
//! no human prompt can be steered into approving them.
//!
//! This is a best-effort lexical screen over every string in the tool input.
//! It cannot see through arbitrary shell obfuscation; it closes the obvious
//! routes and keeps them out of the timed-approval flow.
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
];

fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

/// True when any string in the tool input references a known credential store.
pub(crate) fn references_credential_store(tool_input: &Value) -> bool {
    let mut found = Vec::new();
    strings(tool_input, &mut found);
    found.iter().any(|text| {
        let lower = text.to_ascii_lowercase();
        MARKERS.iter().any(|marker| lower.contains(marker))
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
    fn ordinary_commands_are_not_flagged() {
        for command in ["cargo test", "cat README.md", "security --help", "ls ~/.claude/plugins"] {
            assert!(!references_credential_store(&json!({"command":command})), "{command}");
        }
    }
}
