use crate::repair_feedback::RepairSignalKind;
use crate::validation_oracle;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct QualifiedReproducer {
    pub path: String,
    pub source: String,
    pub issue_anchors: Vec<String>,
    pub baseline_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoredReproducer {
    pub path: String,
    pub issue_anchors: Vec<String>,
    pub baseline_fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReproducerQualification {
    Qualified(QualifiedReproducer),
    Rejected { reason: String },
}

pub fn source_preflight_error(source: &str) -> Option<String> {
    for module in ["pytest", "unittest"] {
        if source_uses_module_api(source, module) && !source_imports_module(source, module) {
            return Some(format!(
                "scratch reproducer uses `{module}.` without importing `{module}`"
            ));
        }
    }
    None
}

pub fn qualify(
    path: &str,
    source: &str,
    issue_anchors: &[String],
    baseline_output: &str,
) -> ReproducerQualification {
    let normalized_path = path.trim().replace('\\', "/");
    if normalized_path.is_empty() || normalized_path.starts_with('/') || normalized_path.contains("../") {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer path must be repository-relative".to_string(),
        };
    }
    if source.trim().is_empty() {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer source is empty".to_string(),
        };
    }
    if let Some(reason) = source_preflight_error(source) {
        return ReproducerQualification::Rejected { reason };
    }
    let lowered = source.to_ascii_lowercase();
    if ["test_patch", "fail_to_pass", "pass_to_pass", "hints_text", "gold patch"]
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer referenced evaluation-only SWE-bench data".to_string(),
        };
    }
    if ["assert false", "pytest.fail(", "raise assertionerror", "unittest.skip", "pytest.skip("]
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer contains an unconditional failure or skip".to_string(),
        };
    }
    if !contains_assertion_or_expected_exception(&lowered) {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer lacks a behavioral assertion or expected exception".to_string(),
        };
    }
    let anchors: Vec<String> = issue_anchors
        .iter()
        .map(|anchor| anchor.trim())
        .filter(|anchor| anchor.len() >= 3)
        .filter(|anchor| source.contains(*anchor))
        .map(ToOwned::to_owned)
        .collect();
    if !issue_anchors.is_empty() && anchors.is_empty() {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer does not exercise an issue-derived anchor".to_string(),
        };
    }
    let kind = crate::repair_feedback::classify_output(baseline_output);
    if kind != RepairSignalKind::AssertionFailure {
        return ReproducerQualification::Rejected {
            reason: format!(
                "scratch reproducer baseline outcome must be a behavioral assertion failure, got {}",
                kind.as_str()
            ),
        };
    }
    if !behavioral_baseline_failure(baseline_output, issue_anchors) {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer baseline failure is neither a behavioral assertion nor an issue-grounded exception".to_string(),
        };
    }
    let fingerprint = validation_oracle::failure_fingerprint(baseline_output);
    if fingerprint.is_empty() {
        return ReproducerQualification::Rejected {
            reason: "scratch reproducer baseline failure has no stable fingerprint".to_string(),
        };
    }
    ReproducerQualification::Qualified(QualifiedReproducer {
        path: normalized_path,
        source: source.to_string(),
        issue_anchors: anchors,
        baseline_fingerprint: fingerprint,
    })
}

/// Extract only issue-derived identifiers that a scratch reproducer can cite.
/// This deliberately avoids repository-name rules and does not consume any
/// evaluation-only metadata.
pub fn issue_anchors_from_task(task: &str) -> Vec<String> {
    let mut anchors = Vec::new();
    for raw in task.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_') {
        let token = raw.trim();
        if token.len() < 4 || token.chars().all(|ch| ch.is_ascii_lowercase()) {
            continue;
        }
        if matches!(
            token.to_ascii_lowercase().as_str(),
            "this" | "that" | "when" | "with" | "from" | "should" | "error" | "issue"
        ) {
            continue;
        }
        if !anchors.iter().any(|existing| existing == token) {
            anchors.push(token.to_string());
        }
    }
    anchors.truncate(8);
    anchors
}

pub fn write_scratch(
    root: &Path,
    name: &str,
    source: &str,
) -> Result<PathBuf, String> {
    let name = validated_scratch_name(name)?;
    if source.trim().is_empty() {
        return Err("scratch reproducer source is empty".to_string());
    }
    std::fs::create_dir_all(root)
        .map_err(|err| format!("create scratch reproducer root {}: {err}", root.display()))?;
    let path = root.join(name);
    std::fs::write(&path, source)
        .map_err(|err| format!("write scratch reproducer {}: {err}", path.display()))?;
    Ok(path)
}

pub fn stored(qualified: &QualifiedReproducer) -> StoredReproducer {
    StoredReproducer {
        path: qualified.path.clone(),
        issue_anchors: qualified.issue_anchors.clone(),
        baseline_fingerprint: qualified.baseline_fingerprint.clone(),
    }
}

fn validated_scratch_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err("scratch reproducer name must be a plain .py filename".to_string());
    }
    if !name.ends_with(".py")
        || !name[..name.len() - 3]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err("scratch reproducer name must match [A-Za-z0-9_]+.py".to_string());
    }
    Ok(name.to_string())
}

fn contains_assertion_or_expected_exception(source: &str) -> bool {
    source.contains("assert ")
        || source.contains("assert(")
        || source.contains("pytest.raises")
        || source.contains("assertraises")
        || source.contains("expect(")
}

fn source_uses_module_api(source: &str, module: &str) -> bool {
    let marker = format!("{module}.");
    source.lines().any(|line| {
        line.split('#')
            .next()
            .unwrap_or_default()
            .contains(&marker)
    })
}

fn source_imports_module(source: &str, module: &str) -> bool {
    source.lines().any(|line| {
        let line = line.split('#').next().unwrap_or_default().trim();
        let Some(imports) = line.strip_prefix("import ") else {
            return false;
        };
        imports.split(',').any(|entry| {
            let entry = entry.trim();
            entry == module
                || entry
                    .strip_prefix(&format!("{module} as "))
                    .is_some_and(|alias| alias.trim() == module)
        })
    })
}

fn behavioral_baseline_failure(output: &str, issue_anchors: &[String]) -> bool {
    let lower = output.to_ascii_lowercase();
    if lower.contains("assertionerror")
        || lower.contains("did not raise")
        || output.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("E   assert ") || line.starts_with("assert ")
        })
    {
        return true;
    }

    issue_anchors.iter().any(|anchor| {
        (anchor.ends_with("Error") || anchor.ends_with("Exception"))
            && output.lines().any(|line| {
                let line = line.trim();
                let line = line
                    .strip_prefix("E   ")
                    .or_else(|| line.strip_prefix("E "))
                    .unwrap_or(line);
                line == anchor
                    || line.starts_with(&format!("{anchor}:"))
                    || line.contains(&format!(" - {anchor}:"))
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASELINE_FAILURE: &str = "FAILED tests/test_format.py::test_compact - AssertionError: expected compact\nSW_TEST_EXIT_CODE=1\n";

    #[test]
    fn accepts_behavioral_issue_anchored_reproducer() {
        let result = qualify(
            ".statewright/repro/test_compact.py",
            "def test_compact():\n    assert format_value(1) == '1'\n",
            &["format_value".to_string()],
            BASELINE_FAILURE,
        );
        assert!(matches!(result, ReproducerQualification::Qualified(_)));
    }

    #[test]
    fn rejects_unconditional_failure() {
        let result = qualify(
            ".statewright/repro/test_compact.py",
            "def test_compact():\n    assert False\n",
            &["format_value".to_string()],
            BASELINE_FAILURE,
        );
        assert!(matches!(result, ReproducerQualification::Rejected { .. }));
    }

    #[test]
    fn rejects_non_behavioral_baseline_result() {
        let result = qualify(
            ".statewright/repro/test_compact.py",
            "def test_compact():\n    assert format_value(1) == '1'\n",
            &["format_value".to_string()],
            "ModuleNotFoundError: no module\nSW_TEST_EXIT_CODE=4\n",
        );
        assert!(matches!(result, ReproducerQualification::Rejected { .. }));
    }

    #[test]
    fn rejects_unbound_pytest_api_before_runtime_evidence() {
        let source = "def test_bug():\n    with pytest.raises(IndexError):\n        identify_format()\n";
        assert!(source_preflight_error(source).is_some());
        assert!(source_preflight_error(&format!("import pytest\n{source}")).is_none());
        assert!(source_preflight_error(&format!("import pytest as pt\n{source}")).is_some());
        let result = qualify(
            ".statewright/repro/test_bug.py",
            source,
            &["IndexError".to_string(), "identify_format".to_string()],
            "FAILED .statewright-reproducer/test_bug.py - NameError: name 'pytest' is not defined\nSW_TEST_EXIT_CODE=1\n",
        );
        assert!(matches!(result, ReproducerQualification::Rejected { .. }));
    }

    #[test]
    fn accepts_issue_grounded_runtime_exception() {
        let result = qualify(
            ".statewright/repro/test_bug.py",
            "def test_bug():\n    assert identify_format() is not None\n",
            &["IndexError".to_string(), "identify_format".to_string()],
            "FAILED .statewright-reproducer/test_bug.py - IndexError: tuple index out of range\nSW_TEST_EXIT_CODE=1\n",
        );
        assert!(matches!(result, ReproducerQualification::Qualified(_)));
    }

    #[test]
    fn rejects_unrelated_runtime_exception_as_causal_evidence() {
        let result = qualify(
            ".statewright/repro/test_bug.py",
            "def test_bug():\n    assert identify_format() is not None\n",
            &["IndexError".to_string(), "identify_format".to_string()],
            "FAILED .statewright-reproducer/test_bug.py - NameError: name 'helper' is not defined\nSW_TEST_EXIT_CODE=1\n",
        );
        assert!(matches!(result, ReproducerQualification::Rejected { .. }));
    }

    #[test]
    fn issue_anchors_keep_code_like_terms_only() {
        assert_eq!(
            issue_anchors_from_task("Fix parse_value when ModelField raises ValueError"),
            vec!["parse_value", "ModelField", "ValueError"]
        );
    }

    #[test]
    fn scratch_writer_rejects_paths_and_writes_external_file() {
        let root = tempfile::tempdir().unwrap();
        assert!(write_scratch(root.path(), "../bad.py", "assert True").is_err());
        let path = write_scratch(root.path(), "test_task.py", "assert True\n").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "assert True\n");
    }
}
