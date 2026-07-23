use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_TOP_FILES: usize = 6;
const MAX_SCOPE_ITEMS: usize = 8;
const MAX_POLICY_REASONS: usize = 4;

#[derive(Clone, Debug, Default, Serialize)]
pub struct CandidateContextPacket {
    pub schema_version: u32,
    pub artifact: &'static str,
    pub benchmark_clean: bool,
    pub source_artifact_dir: Option<String>,
    pub top_files: Vec<ContextFile>,
    pub trusted_test_scope: bool,
    pub advisory_test_files: Vec<String>,
    pub advisory_test_labels: Vec<String>,
    pub baseline_runnable_scopes: Vec<String>,
    pub policy_profile: Option<String>,
    pub workflow_lane: Option<String>,
    pub policy_reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContextFile {
    pub path: String,
    pub score: u64,
    pub reasons: Vec<String>,
}

impl CandidateContextPacket {
    pub fn ranks_source_path(&self, path: &str) -> bool {
        let path = normalize_repo_path(path);
        self.top_files
            .iter()
            .any(|candidate| normalize_repo_path(&candidate.path) == path)
    }

    pub fn load(artifact_dir: &Path, mut baseline_runnable_scopes: Vec<String>) -> Self {
        let problem_shape_path = find_artifact(artifact_dir, "problem-shape.json");
        let policy_path = find_artifact(artifact_dir, "clu-policy.json");
        let problem_shape = problem_shape_path.as_deref().and_then(read_json);
        let policy = policy_path.as_deref().and_then(read_json);

        baseline_runnable_scopes.sort();
        baseline_runnable_scopes.dedup();
        baseline_runnable_scopes.truncate(MAX_SCOPE_ITEMS);

        let top_files = problem_shape
            .as_ref()
            .and_then(|value| value.get("top_files"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let path = entry.get("path")?.as_str()?.trim();
                if path.is_empty() {
                    return None;
                }
                Some(ContextFile {
                    path: path.to_string(),
                    score: entry.get("score").and_then(Value::as_u64).unwrap_or(0),
                    reasons: json_strings(entry.get("reasons"), 3),
                })
            })
            .take(MAX_TOP_FILES)
            .collect();

        let source_artifact_dir = problem_shape_path
            .as_deref()
            .and_then(Path::parent)
            .map(|path| path.display().to_string());

        Self {
            schema_version: 1,
            artifact: "statewright.candidate_context_packet",
            benchmark_clean: true,
            source_artifact_dir,
            top_files,
            trusted_test_scope: problem_shape
                .as_ref()
                .and_then(|value| value.get("trusted_test_scope"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            advisory_test_files: json_strings(
                problem_shape
                    .as_ref()
                    .and_then(|value| value.get("advisory_test_files")),
                MAX_SCOPE_ITEMS,
            ),
            advisory_test_labels: json_strings(
                problem_shape
                    .as_ref()
                    .and_then(|value| value.get("advisory_test_labels")),
                MAX_SCOPE_ITEMS,
            ),
            baseline_runnable_scopes,
            policy_profile: json_string(policy.as_ref(), "profile"),
            workflow_lane: json_string(policy.as_ref(), "workflow_lane"),
            policy_reasons: json_strings(
                policy.as_ref().and_then(|value| value.get("reasons")),
                MAX_POLICY_REASONS,
            ),
        }
    }

    pub fn render(&self) -> String {
        let mut lines = vec![
            "## Parent Evidence Packet".to_string(),
            "Provenance: deterministic parent localization over the public repository and harness-visible public test telemetry only.".to_string(),
        ];
        if self.top_files.is_empty() {
            lines.push(
                "- Ranked source loci: unavailable; inspect the forced path directly.".to_string(),
            );
        } else {
            lines.push("- Ranked source loci:".to_string());
            for file in &self.top_files {
                let reason = if file.reasons.is_empty() {
                    "no additional reason".to_string()
                } else {
                    file.reasons.join("; ")
                };
                lines.push(format!(
                    "  - `{}` score={} ({})",
                    file.path, file.score, reason
                ));
            }
        }
        lines.push(format!(
            "- Parent test-scope trust: {}.",
            if self.trusted_test_scope {
                "baseline-proven public scope"
            } else {
                "advisory only"
            }
        ));
        push_list(
            &mut lines,
            "Baseline-runnable public test files",
            &self.baseline_runnable_scopes,
        );
        push_list(&mut lines, "Advisory test files", &self.advisory_test_files);
        push_list(
            &mut lines,
            "Advisory test labels",
            &self.advisory_test_labels,
        );
        if let Some(profile) = &self.policy_profile {
            lines.push(format!("- CLU profile: `{profile}`."));
        }
        if let Some(lane) = &self.workflow_lane {
            lines.push(format!("- CLU workflow lane: `{lane}`."));
        }
        if !self.policy_reasons.is_empty() {
            lines.push(format!(
                "- Policy reasons: {}.",
                self.policy_reasons.join("; ")
            ));
        }
        lines.join("\n")
    }
}

fn normalize_repo_path(path: &str) -> &str {
    path.trim().trim_start_matches("./")
}

fn find_artifact(start: &Path, name: &str) -> Option<PathBuf> {
    start
        .ancestors()
        .take(6)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn json_string(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn json_strings(value: Option<&Value>, limit: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .take(limit)
        .collect()
}

fn push_list(lines: &mut Vec<String>, label: &str, values: &[String]) {
    if !values.is_empty() {
        lines.push(format!("- {label}: `{}`.", values.join("`, `")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_parent_artifacts_from_nested_fanout_lane() {
        let root = tempfile::tempdir().expect("tempdir");
        let lane = root.path().join("scout-lanes/progressive");
        std::fs::create_dir_all(&lane).expect("mkdir");
        std::fs::write(
            root.path().join("problem-shape.json"),
            r#"{
                "top_files": [{"path":"pkg/source.py","score":91,"reasons":["symbol match"]}],
                "trusted_test_scope": true,
                "advisory_test_files": ["tests/test_source.py"],
                "advisory_test_labels": ["tests.test_source.SourceTests"]
            }"#,
        )
        .expect("shape");
        std::fs::write(
            root.path().join("clu-policy.json"),
            r#"{"profile":"focused","workflow_lane":"scope_first","reasons":["strong locus"]}"#,
        )
        .expect("policy");

        let packet = CandidateContextPacket::load(&lane, vec!["tests/test_source.py".to_string()]);

        assert_eq!(packet.top_files[0].path, "pkg/source.py");
        assert!(packet.trusted_test_scope);
        assert_eq!(packet.policy_profile.as_deref(), Some("focused"));
        let rendered = packet.render();
        assert!(rendered.contains("`pkg/source.py` score=91"));
        assert!(rendered.contains("Baseline-runnable public test files"));
        assert!(packet.ranks_source_path("./pkg/source.py"));
        assert!(!packet.ranks_source_path("pkg/unrelated.py"));
    }
}
