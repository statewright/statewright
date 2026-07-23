use crate::repair_feedback::RepairSignalKind;
use crate::validation_oracle::BaselineScopeRelation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaselineQualification {
    pub relation: BaselineScopeRelation,
    pub reason: String,
}

/// Classify a source-mapped public test run against the untouched repository.
///
/// A pre-existing failure in a nearby public test cannot prove that the test
/// exercises the reported issue. That requires a separately constructed,
/// task-derived reproducer with explicit provenance. This function therefore
/// never grants issue authority to a failing source-mapped scope.
pub fn qualify_source_mapped_public_scope(kind: RepairSignalKind) -> BaselineQualification {
    match kind {
        RepairSignalKind::Passed => BaselineQualification {
            relation: BaselineScopeRelation::Regression,
            reason: "source-mapped public scope passed on the unmodified baseline".to_string(),
        },
        RepairSignalKind::AssertionFailure | RepairSignalKind::UnknownFailure => {
            BaselineQualification {
                relation: BaselineScopeRelation::UnrelatedFailure,
                reason: "source-mapped public scope already failed on the unmodified baseline; only a separately identified task-derived reproducer can establish issue causality"
                    .to_string(),
            }
        }
        _ => BaselineQualification {
            relation: BaselineScopeRelation::Unknown,
            reason: format!(
                "{} is not a runnable public baseline outcome",
                kind.as_str()
            ),
        },
    }
}

pub fn task_signal_region(task: &str) -> String {
    let without_comments = strip_html_comments(task);
    let mut retained = Vec::new();
    for line in without_comments.lines() {
        let heading = line.trim().to_ascii_lowercase();
        if matches!(
            heading.as_str(),
            "### versions"
                | "## versions"
                | "### version"
                | "## version"
                | "### system details"
                | "## system details"
                | "### environment"
                | "## environment"
                | "### platform"
                | "## platform"
        ) {
            break;
        }
        retained.push(line);
    }
    retained.join("\n")
}

fn strip_html_comments(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    loop {
        let Some(start) = rest.find("<!--") else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..start]);
        let after_start = &rest[start + 4..];
        let Some(end) = after_start.find("-->") else {
            break;
        };
        rest = &after_start[end + 3..];
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passing_public_scope_is_regression_evidence() {
        let result = qualify_source_mapped_public_scope(RepairSignalKind::Passed);
        assert_eq!(result.relation, BaselineScopeRelation::Regression);
    }

    #[test]
    fn public_assertion_failure_cannot_become_issue_evidence() {
        let result = qualify_source_mapped_public_scope(RepairSignalKind::AssertionFailure);
        assert_eq!(result.relation, BaselineScopeRelation::UnrelatedFailure);
        assert!(result.reason.contains("task-derived reproducer"));
    }

    #[test]
    fn public_unknown_failure_cannot_become_issue_evidence() {
        let result = qualify_source_mapped_public_scope(RepairSignalKind::UnknownFailure);
        assert_eq!(result.relation, BaselineScopeRelation::UnrelatedFailure);
    }

    #[test]
    fn non_test_outcome_has_no_baseline_authority() {
        let result = qualify_source_mapped_public_scope(RepairSignalKind::EnvUnavailable);
        assert_eq!(result.relation, BaselineScopeRelation::Unknown);
    }

    #[test]
    fn task_signal_region_removes_template_metadata_and_comments() {
        let task = r#"
Repair `format_value` for compact output.
<!-- generated issue metadata -->
### System Details
runtime 1.2.3
"#;
        let result = task_signal_region(task);
        assert!(result.contains("format_value"));
        assert!(!result.contains("generated issue metadata"));
        assert!(!result.contains("runtime 1.2.3"));
    }
}
