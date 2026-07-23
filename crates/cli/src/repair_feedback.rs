use serde_json::json;

const REPAIR_MARKER: &str = "[POST_EDIT_REPAIR]";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepairSignalKind {
    Passed,
    AssertionFailure,
    SyntaxOrCollection,
    InvalidScope,
    EnvUnavailable,
    Timeout,
    UnknownFailure,
}

impl RepairSignalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RepairSignalKind::Passed => "passed",
            RepairSignalKind::AssertionFailure => "assertion_failure",
            RepairSignalKind::SyntaxOrCollection => "syntax_or_collection",
            RepairSignalKind::InvalidScope => "invalid_scope",
            RepairSignalKind::EnvUnavailable => "env_unavailable",
            RepairSignalKind::Timeout => "timeout",
            RepairSignalKind::UnknownFailure => "unknown_failure",
        }
    }

    pub fn is_candidate_blocking(self) -> bool {
        matches!(
            self,
            RepairSignalKind::AssertionFailure
                | RepairSignalKind::SyntaxOrCollection
                | RepairSignalKind::UnknownFailure
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeCandidate {
    pub path: String,
    pub score: usize,
    pub reason: String,
    pub authoritative: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeAttempt {
    pub scope: serde_json::Value,
    pub desc: String,
    pub files: Vec<String>,
    pub authoritative: bool,
    pub max_score: usize,
}

pub fn scope_attempts_from_candidates(
    candidates: &[ScopeCandidate],
    desc_prefix: &str,
    max_singletons: usize,
    group_last: bool,
) -> Vec<ScopeAttempt> {
    let mut paths: Vec<ScopeCandidate> = Vec::new();
    for candidate in candidates {
        let path = normalize_path(&candidate.path);
        if !path.is_empty() && !paths.iter().any(|existing| existing.path == path) {
            paths.push(ScopeCandidate {
                path,
                score: candidate.score,
                reason: candidate.reason.clone(),
                authoritative: candidate.authoritative,
            });
        }
    }
    if paths.is_empty() {
        return Vec::new();
    }

    let mut attempts = Vec::new();
    let singleton_attempts: Vec<ScopeAttempt> = paths
        .iter()
        .take(max_singletons.max(1))
        .map(|candidate| scope_attempt_from_candidates(&[candidate.clone()], desc_prefix))
        .collect();
    let group_attempt = if paths.len() > 1 {
        Some(scope_attempt_from_candidates(&paths, desc_prefix))
    } else {
        None
    };

    if !group_last {
        if let Some(group) = group_attempt.clone() {
            attempts.push(group);
        }
    }
    attempts.extend(singleton_attempts);
    if group_last {
        if let Some(group) = group_attempt {
            attempts.push(group);
        }
    }
    attempts
}

pub fn classify_output(output: &str) -> RepairSignalKind {
    if output.contains("SW_TEST_ENV_UNAVAILABLE=1")
        || output.contains("test runner unavailable")
        || output.contains("environment unavailable")
    {
        return RepairSignalKind::EnvUnavailable;
    }
    if output.contains("SW_TEST_TIMED_OUT=1")
        || output.contains("signal: timed out")
        || output.contains("timed out")
    {
        return RepairSignalKind::Timeout;
    }
    if exit_code(output) == Some(5)
        || contains_case_insensitive(output, "no tests collected")
        || contains_case_insensitive(output, "no tests ran")
        || output.contains("collected 0 items")
        || output.contains("Ran 0 tests")
    {
        return RepairSignalKind::InvalidScope;
    }
    if exit_code(output) == Some(4)
        || output.contains("ERROR collecting")
        || output.contains("errors during collection")
        || output.contains("ImportError while loading conftest")
        || output.contains("ModuleNotFoundError")
        || output.contains("ImportError:")
        || output.contains("SyntaxError")
        || output.contains("IndentationError")
        || output.contains("TabError")
    {
        return RepairSignalKind::SyntaxOrCollection;
    }
    if exit_code(output) == Some(0) && !contains_failure_signal(output) {
        return RepairSignalKind::Passed;
    }
    if exit_code(output).is_some_and(|code| code != 0) {
        if contains_failure_signal(output) {
            RepairSignalKind::AssertionFailure
        } else {
            RepairSignalKind::UnknownFailure
        }
    } else if contains_failure_signal(output) {
        RepairSignalKind::AssertionFailure
    } else {
        RepairSignalKind::UnknownFailure
    }
}

pub fn render_repair_card(
    kind: RepairSignalKind,
    scope_desc: &str,
    output: &str,
    changed_sources: &[String],
    model: &str,
) -> String {
    let command = command_line(output).unwrap_or("unknown command");
    let mut lines = vec![
        format!(
            "{REPAIR_MARKER} FAIL kind={} scope={}",
            kind.as_str(),
            scope_desc
        ),
        format!("{REPAIR_MARKER} command: {}", command),
    ];
    if !changed_sources.is_empty() {
        lines.push(format!(
            "{REPAIR_MARKER} changed_source: {}",
            changed_sources
                .iter()
                .take(4)
                .map(|path| path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    lines.push(format!(
        "{REPAIR_MARKER} note: scoped source-derived telemetry, not official completion proof"
    ));
    lines.push(format!(
        "Source-derived tests failed after the edit. Use this concrete failure to repair the current patch; do not edit tests or broaden into unrelated files."
    ));
    lines.extend(
        interesting_lines(output, model)
            .into_iter()
            .map(|line| format!("  {}", line)),
    );
    lines.join("\n")
}

pub fn render_skip_line(kind: RepairSignalKind, scope_desc: &str) -> String {
    format!(
        "{REPAIR_MARKER} SKIP kind={} scope={}",
        kind.as_str(),
        scope_desc
    )
}

pub fn render_pass_line(scope_desc: &str, output: &str) -> String {
    let command = command_line(output).unwrap_or("unknown command");
    format!(
        "{REPAIR_MARKER} PASS authority=baseline_failure_repaired scope={}\n{REPAIR_MARKER} command: {}\n{REPAIR_MARKER} note: a recorded baseline failure now passes in the source-derived scope; canonical eval still required",
        scope_desc, command
    )
}

pub fn render_regression_pass_line(scope_desc: &str, output: &str) -> String {
    let command = command_line(output).unwrap_or("unknown command");
    format!(
        "{REPAIR_MARKER} REGRESSION_PASS authority=baseline_regression_scope scope={}\n{REPAIR_MARKER} command: {}\n{REPAIR_MARKER} note: a baseline-passing source-derived scope still passes; this is regression coverage, not repair evidence",
        scope_desc, command
    )
}

fn scope_attempt_from_candidates(candidates: &[ScopeCandidate], desc_prefix: &str) -> ScopeAttempt {
    let files: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect();
    let first = files[0].clone();
    let rest = files[1..].to_vec();
    let desc = if rest.is_empty() {
        format!("{}={}", desc_prefix, first)
    } else {
        format!("{}={} (+{} more)", desc_prefix, first, rest.len())
    };
    let scope = if rest.is_empty() {
        json!({"path": first})
    } else {
        json!({"path": first, "args": rest})
    };
    ScopeAttempt {
        scope,
        desc,
        files: files.to_vec(),
        authoritative: candidates.iter().all(|candidate| candidate.authoritative),
        max_score: candidates
            .iter()
            .map(|candidate| candidate.score)
            .max()
            .unwrap_or(0),
    }
}

fn command_line(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("SW_TEST_COMMAND="))
}

fn exit_code(output: &str) -> Option<i32> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("SW_TEST_EXIT_CODE="))
        .and_then(|value| value.trim().parse::<i32>().ok())
}

fn interesting_lines(output: &str, model: &str) -> Vec<String> {
    let limit = if model.to_ascii_lowercase().contains("8b") {
        8
    } else {
        14
    };
    let mut lines: Vec<String> = output
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| {
            line.starts_with("FAILED")
                || line.starts_with("ERROR")
                || line.contains("FAIL:")
                || line.contains("ERROR:")
                || line.contains("Traceback")
                || line.contains("AssertionError")
                || line.contains("ImportError")
                || line.contains("ModuleNotFoundError")
                || line.contains("NameError")
                || line.contains("ValueError")
                || line.contains("TypeError")
                || line.contains("SyntaxError")
                || line.contains("IndentationError")
                || line.contains("expected")
                || line.contains("actual")
                || line.contains("assert ")
                || line.trim_start().starts_with("E   ")
        })
        .map(|line| line.chars().take(260).collect::<String>())
        .collect();
    if lines.is_empty() {
        lines = output
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty())
            .take(limit.min(8))
            .map(|line| line.chars().take(260).collect::<String>())
            .collect::<Vec<_>>();
        lines.reverse();
    }
    lines.truncate(limit);
    lines
}

fn contains_failure_signal(output: &str) -> bool {
    output.contains("FAILED")
        || output.contains("FAIL:")
        || output.contains("ERROR:")
        || output.contains("Traceback")
        || output.contains("AssertionError")
        || output.contains("\nE   ")
        || output.contains("assert ")
}

fn contains_case_insensitive(output: &str, needle: &str) -> bool {
    output
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_pytest_exit_codes() {
        assert_eq!(
            classify_output("SW_TEST_EXIT_CODE=5\nno tests collected\n"),
            RepairSignalKind::InvalidScope
        );
        assert_eq!(
            classify_output("SW_TEST_EXIT_CODE=4\nERROR collecting tests/test_x.py\n"),
            RepairSignalKind::SyntaxOrCollection
        );
        assert_eq!(
            classify_output(
                "FAILED tests/test_x.py::test_x\nE   assert 1 == 2\nSW_TEST_EXIT_CODE=1\n"
            ),
            RepairSignalKind::AssertionFailure
        );
        assert_eq!(
            classify_output("1 passed\nSW_TEST_EXIT_CODE=0\n"),
            RepairSignalKind::Passed
        );
    }

    #[test]
    fn singleton_scope_attempts_precede_group_by_default() {
        let candidates = vec![
            ScopeCandidate {
                path: "tests/test_alpha.py".into(),
                score: 90,
                reason: "stem match".into(),
                authoritative: true,
            },
            ScopeCandidate {
                path: "tests/test_beta.py".into(),
                score: 80,
                reason: "symbol hit".into(),
                authoritative: false,
            },
        ];
        let attempts = scope_attempts_from_candidates(&candidates, "SOURCE_SCOPE", 4, true);
        assert_eq!(attempts[0].desc, "SOURCE_SCOPE=tests/test_alpha.py");
        assert_eq!(attempts[1].desc, "SOURCE_SCOPE=tests/test_beta.py");
        assert_eq!(
            attempts[2].desc,
            "SOURCE_SCOPE=tests/test_alpha.py (+1 more)"
        );
        assert!(attempts[0].authoritative);
        assert!(!attempts[1].authoritative);
        assert!(!attempts[2].authoritative);
        assert_eq!(attempts[2].max_score, 90);
    }

    #[test]
    fn repair_card_has_parseable_failure_marker() {
        let card = render_repair_card(
            RepairSignalKind::SyntaxOrCollection,
            "SOURCE_SCOPE=tests/test_x.py",
            "SW_TEST_COMMAND=pytest tests/test_x.py\nSyntaxError: invalid syntax\nSW_TEST_EXIT_CODE=4\n",
            &["pkg/x.py".into()],
            "qwen3:8b",
        );
        assert!(card.contains("[POST_EDIT_REPAIR] FAIL kind=syntax_or_collection"));
        assert!(card.contains("[POST_EDIT_REPAIR] command: pytest tests/test_x.py"));
        assert!(card.contains("pkg/x.py"));
    }
}
