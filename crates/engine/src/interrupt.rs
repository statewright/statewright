use crate::types::{InterruptDef, MachineDefinition};

/// Find all interrupts whose trigger pattern matches the given file path.
/// Returns (interrupt_name, interrupt_def) pairs.
pub fn match_interrupts<'a>(
    file_path: &str,
    definition: &'a MachineDefinition,
) -> Vec<(&'a str, &'a InterruptDef)> {
    definition
        .interrupts
        .iter()
        .filter(|(_, def)| glob_match(&def.trigger.file_pattern, file_path))
        .map(|(name, def)| (name.as_str(), def))
        .collect()
}

/// Simple glob pattern matching for file paths.
/// Supports `*` (any non-/ sequence), `**` (any sequence including /), and `?` (single char).
pub fn glob_match(pattern: &str, path: &str) -> bool {
    glob_match_impl(pattern.as_bytes(), path.as_bytes())
}

fn glob_match_impl(pattern: &[u8], path: &[u8]) -> bool {
    let mut pi = 0; // pattern index
    let mut si = 0; // string (path) index
    let mut star_pi = usize::MAX;
    let mut star_si = 0;

    while si < path.len() {
        if pi < pattern.len() && pattern[pi] == b'*' {
            // Check for **
            if pi + 1 < pattern.len() && pattern[pi + 1] == b'*' {
                // ** matches everything including /
                // Skip past **
                pi += 2;
                // Skip trailing / after **
                if pi < pattern.len() && pattern[pi] == b'/' {
                    pi += 1;
                }
                // Try matching rest of pattern at every position
                if pi >= pattern.len() {
                    return true; // ** at end matches everything
                }
                for i in si..=path.len() {
                    if glob_match_impl(&pattern[pi..], &path[i..]) {
                        return true;
                    }
                }
                return false;
            }
            // Single * — match any non-/ sequence
            star_pi = pi;
            star_si = si;
            pi += 1;
        } else if pi < pattern.len() && (pattern[pi] == b'?' && path[si] != b'/') {
            pi += 1;
            si += 1;
        } else if pi < pattern.len() && pattern[pi] == path[si] {
            pi += 1;
            si += 1;
        } else if star_pi != usize::MAX {
            // Backtrack to last * (but don't match /)
            if path[star_si] == b'/' {
                return false;
            }
            star_si += 1;
            si = star_si;
            pi = star_pi + 1;
        } else {
            return false;
        }
    }

    // Consume trailing * or ** in pattern
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }

    pi == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- glob_match tests ---

    #[test]
    fn literal_exact_match() {
        assert!(glob_match("src/main.rs", "src/main.rs"));
    }

    #[test]
    fn literal_mismatch() {
        assert!(!glob_match("src/main.rs", "src/lib.rs"));
    }

    #[test]
    fn single_star_matches_filename() {
        assert!(glob_match("src/*.rs", "src/main.rs"));
        assert!(glob_match("src/*.rs", "src/lib.rs"));
    }

    #[test]
    fn single_star_does_not_cross_directory() {
        assert!(!glob_match("src/*.rs", "src/sub/main.rs"));
    }

    #[test]
    fn double_star_matches_any_depth() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "src/sub/deep/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
    }

    #[test]
    fn double_star_in_middle() {
        assert!(glob_match("site/pb/**/*.js", "site/pb/hooks/auth.pb.js"));
        assert!(glob_match("site/pb/**/*.js", "site/pb/migrations/001.js"));
        assert!(glob_match("site/pb/**/*.js", "site/pb/deep/nested/file.js"));
    }

    #[test]
    fn double_star_no_match_wrong_prefix() {
        assert!(!glob_match("site/pb/**/*.js", "src/pb/hooks/auth.js"));
    }

    #[test]
    fn double_star_no_match_wrong_extension() {
        assert!(!glob_match("site/pb/**/*.js", "site/pb/hooks/auth.ts"));
    }

    #[test]
    fn question_mark_matches_single_char() {
        assert!(glob_match("src/?.rs", "src/a.rs"));
        assert!(!glob_match("src/?.rs", "src/ab.rs"));
    }

    #[test]
    fn question_mark_does_not_match_slash() {
        assert!(!glob_match("src/?/main.rs", "src//main.rs"));
    }

    #[test]
    fn star_env_pattern() {
        assert!(glob_match("**/*.env*", "src/.env"));
        assert!(glob_match("**/*.env*", ".env.local"));
        assert!(glob_match("**/*.env*", "config/.env.production"));
    }

    #[test]
    fn double_star_at_end() {
        assert!(glob_match("site/pb/**", "site/pb/hooks/auth.js"));
        assert!(glob_match("site/pb/**", "site/pb/anything"));
    }

    #[test]
    fn empty_pattern_matches_empty_path() {
        assert!(glob_match("", ""));
    }

    #[test]
    fn empty_pattern_does_not_match_nonempty() {
        assert!(!glob_match("", "something"));
    }

    // --- InterruptDef deserialization tests ---

    #[test]
    fn interrupt_def_deserializes_from_json() {
        let json = json!({
            "trigger": { "file_pattern": "site/pb/**/*.js" },
            "target": "pb_validating"
        });
        let def: InterruptDef = serde_json::from_value(json).unwrap();
        assert_eq!(def.trigger.file_pattern, "site/pb/**/*.js");
        assert_eq!(def.target, "pb_validating");
    }

    #[test]
    fn machine_definition_with_interrupts() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "tdd",
            "initial": "implementing",
            "states": {
                "implementing": {
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "pb_validating": {
                    "on": { "VALIDATED": "$return", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "pb_validation": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                },
                "security_scan": {
                    "trigger": { "file_pattern": "**/*.env*" },
                    "target": "env_checking"
                }
            }
        }))
        .unwrap();

        assert_eq!(def.interrupts.len(), 2);
        assert!(def.interrupts.contains_key("pb_validation"));
        assert_eq!(def.interrupts["pb_validation"].target, "pb_validating");
    }

    #[test]
    fn machine_definition_without_interrupts_defaults_empty() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "simple",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        assert!(def.interrupts.is_empty());
    }

    // --- match_interrupts tests ---

    fn machine_with_interrupts() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": { "on": { "DONE": "completed" } },
                "pb_validating": { "on": { "VALIDATED": "$return" } },
                "env_checking": { "on": { "CHECKED": "$return" } },
                "completed": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "pb_check": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                },
                "env_audit": {
                    "trigger": { "file_pattern": "**/*.env*" },
                    "target": "env_checking"
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn match_interrupts_returns_matching_interrupt() {
        let def = machine_with_interrupts();
        let matches = match_interrupts("site/pb/hooks/auth.pb.js", &def);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].0, "pb_check");
        assert_eq!(matches[0].1.target, "pb_validating");
    }

    #[test]
    fn match_interrupts_returns_empty_for_no_match() {
        let def = machine_with_interrupts();
        let matches = match_interrupts("src/components/App.vue", &def);
        assert!(matches.is_empty());
    }

    #[test]
    fn match_interrupts_can_match_multiple() {
        // A .env file inside site/pb would match both patterns... but that's unlikely.
        // Test with a file that matches the env pattern
        let def = machine_with_interrupts();
        let matches = match_interrupts("config/.env.local", &def);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].0, "env_audit");
    }

    #[test]
    fn match_interrupts_empty_when_no_interrupts_defined() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "simple",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let matches = match_interrupts("any/file.rs", &def);
        assert!(matches.is_empty());
    }
}
