//! Canonical native-adapter tool identity.
//!
//! This module classifies identity, not authority.  Callers may use it only
//! after transport provenance establishes that a call came from a trusted
//! native adapter.  Ordinary upstream MCP tools retain their registered
//! metadata and exact identity even when their names collide with these
//! aliases.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeToolFamily {
    Read,
    Write,
    Command,
    Test,
    Fetch,
    Search,
    Agent,
}

impl NativeToolFamily {
    pub const fn policy_name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Command => "command",
            Self::Test => "test",
            Self::Fetch => "fetch",
            Self::Search => "search",
            Self::Agent => "agent",
        }
    }
}

fn native_leaf_name(name: &str) -> &str {
    name.strip_prefix("functions.")
        .or_else(|| name.strip_prefix("functions::"))
        .unwrap_or(name)
}

pub fn native_tool_family(name: &str) -> Option<NativeToolFamily> {
    use NativeToolFamily::*;

    match native_leaf_name(name).to_ascii_lowercase().as_str() {
        "read" | "read_file" | "grep" | "search_files" | "glob" | "find" | "find_files" | "ls"
        | "list_directory" | "view_image" => Some(Read),
        "edit"
        | "edit_file"
        | "apply_patch"
        | "applypatch"
        | "patch_file"
        | "multiedit"
        | "write"
        | "write_file"
        | "create_file"
        | "create_or_update_file"
        | "strreplace"
        | "str_replace" => Some(Write),
        "bash" | "exec_command" | "run_command" | "shell" | "terminal" => Some(Command),
        "run_test" => Some(Test),
        "webfetch" | "fetch" | "http_request" => Some(Fetch),
        "websearch" | "web_search" => Some(Search),
        "agent" | "subagent" => Some(Agent),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_are_case_insensitive_and_native_namespaces_are_bounded() {
        for alias in [
            "Write",
            "write",
            "Edit",
            "edit",
            "MultiEdit",
            "multiedit",
            "apply_patch",
            "ApplyPatch",
            "StrReplace",
            "str_replace",
            "functions.apply_patch",
            "functions::write_file",
        ] {
            assert_eq!(
                native_tool_family(alias),
                Some(NativeToolFamily::Write),
                "{alias}"
            );
        }
        for alias in [
            "Read",
            "read_file",
            "Grep",
            "find_files",
            "view_image",
            "functions.view_image",
        ] {
            assert_eq!(
                native_tool_family(alias),
                Some(NativeToolFamily::Read),
                "{alias}"
            );
        }
        assert_eq!(native_tool_family("mcp__files__write_file"), None);
        assert_eq!(native_tool_family("write_stdin"), None);
    }
}
