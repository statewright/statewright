//! Deterministic, solver-visible source-to-public-test mapping.
//!
//! This module intentionally contains no repository-name branches. It ranks
//! public tests using only source definitions, source/test path structure, and
//! issue identifiers that can be corroborated by source or test content.

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TestMapCandidate {
    pub path: String,
    pub score: usize,
    pub reason: String,
    pub trust_tier: String,
}

/// A compact record of an actual baseline TestSpec execution. Raw test output
/// stays in the execution ledger; this artifact only carries the deterministic
/// identity and classification needed to explain later candidate decisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BaselineObservation {
    pub scope_desc: String,
    pub scope_keys: Vec<String>,
    pub signal: String,
    pub relation: String,
    pub fingerprint: String,
    pub usable_for_candidate_comparison: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CausalTestMap {
    pub schema_version: u8,
    pub artifact: &'static str,
    pub source_paths: Vec<String>,
    pub issue_tokens: Vec<String>,
    pub candidates: Vec<TestMapCandidate>,
    pub baseline_observations: Vec<BaselineObservation>,
}

impl CausalTestMap {
    pub fn record_baseline_observation(&mut self, observation: BaselineObservation) {
        self.baseline_observations.push(observation);
    }
}

pub fn build(
    workdir: &str,
    source_paths: &[String],
    all_files: &[String],
    task: &str,
    limit: usize,
) -> CausalTestMap {
    let sources: Vec<String> = source_paths
        .iter()
        .map(|path| normalize(path))
        .filter(|path| is_source_path(path))
        .filter(|path| Path::new(workdir).join(path).is_file())
        .collect();
    let tests: Vec<String> = all_files
        .iter()
        .map(|path| normalize(path))
        .filter(|path| is_test_path(path))
        .filter(|path| Path::new(workdir).join(path).is_file())
        .collect();
    let issue_tokens = issue_tokens(task);
    let issue_literals = issue_literals(task);
    let mut candidates = Vec::new();
    for test in &tests {
        let mut best = None;
        for source in &sources {
            let candidate = score_pair(workdir, source, test, &issue_tokens, &issue_literals, task);
            if candidate.score < 60 {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|current: &TestMapCandidate| candidate.score > current.score)
            {
                best = Some(candidate);
            }
        }
        if let Some(candidate) = best {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| test_path_rank(&left.path).cmp(&test_path_rank(&right.path)))
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(limit.max(1));
    CausalTestMap {
        schema_version: 2,
        artifact: "statewright.causal_test_map",
        source_paths: sources,
        issue_tokens,
        candidates,
        baseline_observations: Vec::new(),
    }
}

fn score_pair(
    workdir: &str,
    source: &str,
    test: &str,
    issue_tokens: &[String],
    issue_literals: &[String],
    task: &str,
) -> TestMapCandidate {
    let source_content =
        std::fs::read_to_string(Path::new(workdir).join(source)).unwrap_or_default();
    let test_content = std::fs::read_to_string(Path::new(workdir).join(test)).unwrap_or_default();
    let source_lower = source_content.to_ascii_lowercase();
    let test_lower = test_content.to_ascii_lowercase();
    let source_stem = stem(source);
    let source_parts = path_parts(source);
    let test_parts = path_parts(test);
    let mut score = 0usize;
    let mut reasons = Vec::new();

    if !source_stem.is_empty() && test_lower.contains(&source_stem) {
        let occurrences = test_lower.matches(&source_stem).count();
        // Dense source references remain useful, but the cap keeps them below
        // multiple task-specific source/test anchors scored below.
        score += 20 + occurrences.min(24) * 4;
        reasons.push(format!("test references source stem `{source_stem}`"));
    }
    let test_filename = stem(test);
    if !source_stem.is_empty()
        && (test_filename == format!("test_{source_stem}")
            || test_filename == format!("{source_stem}_test")
            || test_filename == format!("{source_stem}_tests"))
    {
        score += 120;
        reasons.push(format!(
            "exact source/test basename mapping for `{source_stem}`"
        ));
    } else if !source_stem.is_empty() && test_filename.contains(&source_stem) {
        score += 45;
        reasons.push(format!(
            "test filename contains source stem `{source_stem}`"
        ));
    }

    let source_compound = source_compound(source);
    if source_compound.len() >= 8 && compact(task).contains(&source_compound) {
        let source_parent = path_parts(source)
            .into_iter()
            .rev()
            .nth(1)
            .unwrap_or_default();
        let source_shape_match =
            test_filename.contains(&source_stem) || test_lower.contains(&source_stem);
        let package_affinity = test_parts
            .iter()
            .any(|part| path_component_affinity(part, &source_parent));
        if source_shape_match && package_affinity {
            // The task explicitly names the source module/class compound.
            // Require corroborating package affinity so a common source stem
            // cannot promote an unrelated same-named test in another domain.
            score += 500;
            reasons.push(format!(
                "issue names source compound `{source_compound}` with package affinity `{source_parent}`"
            ));
        }
    }

    let source_symbols = definitions(&source_content);
    let shared_symbols: Vec<&String> = source_symbols
        .iter()
        .filter(|symbol| symbol.len() >= 4 && test_content.contains(symbol.as_str()))
        .collect();
    if !shared_symbols.is_empty() {
        score += shared_symbols.len().min(3) * 28;
        reasons.push(format!(
            "test references source symbol(s) `{}`",
            shared_symbols
                .iter()
                .take(3)
                .map(|symbol| symbol.as_str())
                .collect::<Vec<_>>()
                .join("`, `")
        ));
    }

    let shared_parts = shared_path_parts(&source_parts, &test_parts);
    if !shared_parts.is_empty() {
        score += shared_parts.len().min(3) * 22;
        reasons.push(format!(
            "source/test package overlap `{}`",
            shared_parts
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("`, `")
        ));
    }

    let near_parts = near_path_parts(&source_parts, &test_parts);
    if !near_parts.is_empty() {
        score += near_parts.len().min(2) * 30;
        reasons.push(format!(
            "source/test package-prefix overlap `{}`",
            near_parts
                .iter()
                .take(2)
                .cloned()
                .collect::<Vec<_>>()
                .join("`, `")
        ));
    }

    let source_issue_anchors: Vec<&String> = issue_tokens
        .iter()
        .filter(|token| {
            source_lower.contains(token.as_str())
                || source_parts.iter().skip(1).any(|part| {
                    part == *token
                        || part.starts_with(token.as_str())
                        || token.starts_with(part.as_str())
                })
        })
        .collect();
    let direct_issue_hits: Vec<&String> = source_issue_anchors
        .iter()
        .copied()
        .filter(|token| {
            test_lower.contains(token.as_str())
                || test_parts.iter().any(|part| part == token.as_str())
        })
        .collect();
    let transitive_issue_hits: Vec<&String> = issue_tokens
        .iter()
        .filter(|token| {
            test_lower.contains(token.as_str()) || test_parts.iter().any(|part| part == *token)
        })
        .collect();
    let (issue_hits, issue_hit_score) = if !direct_issue_hits.is_empty() {
        let score = direct_issue_hits
            .iter()
            .take(3)
            .map(|token| {
                if token.len() >= 6 || token.contains('_') {
                    100
                } else {
                    30
                }
            })
            .sum();
        (direct_issue_hits, score)
    } else if !source_issue_anchors.is_empty() {
        let score = transitive_issue_hits.len().min(3) * 30;
        (transitive_issue_hits, score)
    } else {
        (Vec::new(), 0)
    };
    if !issue_hits.is_empty() {
        score += issue_hit_score;
        reasons.push(format!(
            "test references issue/source identifier(s) `{}`",
            issue_hits
                .iter()
                .take(3)
                .map(|token| token.as_str())
                .collect::<Vec<_>>()
                .join("`, `")
        ));
    }

    let matched_literals: Vec<&String> = issue_literals
        .iter()
        .filter(|literal| test_content.contains(literal.as_str()))
        .collect();
    if !matched_literals.is_empty() {
        score += matched_literals.len().min(2) * 55;
        reasons.push(format!(
            "test preserves issue literal(s) `{}`",
            matched_literals
                .iter()
                .take(2)
                .map(|literal| literal.as_str())
                .collect::<Vec<_>>()
                .join("`, `")
        ));
    }

    let trust_tier = if reasons
        .iter()
        .any(|reason| reason.contains("exact source/test"))
    {
        "source_exact"
    } else if reasons
        .iter()
        .any(|reason| reason.contains("issue/source identifier"))
    {
        "issue_local"
    } else {
        "source_adjacent"
    };
    TestMapCandidate {
        path: test.to_string(),
        score,
        reason: reasons.join("; "),
        trust_tier: trust_tier.to_string(),
    }
}

fn normalize(path: &str) -> String {
    path.trim().trim_start_matches("./").replace('\\', "/")
}

fn is_source_path(path: &str) -> bool {
    matches!(
        Path::new(path).extension().and_then(|value| value.to_str()),
        Some("py" | "pyx" | "pxd" | "pxi" | "rs" | "js" | "ts" | "tsx" | "jsx" | "go" | "java")
    ) && !is_test_path(path)
}

fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = Path::new(&lower)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    !matches!(name, "runtests.py" | "run_tests.py" | "conftest.py")
        && (name.starts_with("test_")
            || name == "test.py"
            || name == "tests.py"
            || name.ends_with("_test.py")
            || name.ends_with("_tests.py")
            || name.ends_with(".test.js")
            || name.ends_with(".spec.js")
            || name.ends_with(".test.ts")
            || name.ends_with(".spec.ts")
            || ((lower.starts_with("tests/") || lower.contains("/tests/"))
                && name.ends_with(".rs")))
}

fn stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim_start_matches('_')
        .to_ascii_lowercase()
}

fn path_parts(path: &str) -> Vec<String> {
    path.split('/')
        .flat_map(|part| {
            part.trim_end_matches(".py")
                .trim_end_matches(".pyx")
                .split(['_', '-'])
        })
        .map(|part| {
            part.trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
                .to_ascii_lowercase()
        })
        .filter(|part| part.len() >= 3)
        .filter(|part| {
            !matches!(
                part.as_str(),
                "src" | "lib" | "test" | "tests" | "python" | "package"
            )
        })
        .collect()
}

fn shared_path_parts(source: &[String], test: &[String]) -> Vec<String> {
    source
        .iter()
        .filter(|part| test.iter().any(|candidate| candidate == *part))
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn near_path_parts(source: &[String], test: &[String]) -> Vec<String> {
    source
        .iter()
        .filter(|part| {
            part.len() >= 4
                && test.iter().any(|candidate| {
                    candidate.len() >= 4
                        && (candidate.starts_with(part.as_str())
                            || part.starts_with(candidate.as_str()))
                })
        })
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

fn path_component_affinity(left: &str, right: &str) -> bool {
    !left.is_empty()
        && !right.is_empty()
        && (left == right
            || (left.len() >= 4
                && right.len() >= 4
                && (left.starts_with(right) || right.starts_with(left))))
}

fn definitions(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        let candidate = trimmed
            .strip_prefix("def ")
            .or_else(|| trimmed.strip_prefix("async def "))
            .or_else(|| trimmed.strip_prefix("cdef class "))
            .or_else(|| trimmed.strip_prefix("class "));
        let Some(candidate) = candidate else { continue };
        let name = candidate
            .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
            .next()
            .unwrap_or_default();
        if name.len() >= 4 && !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
    names
}

fn issue_tokens(task: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in task.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_') {
        let raw = raw.trim();
        if raw.len() < 4 || generic_word(raw) {
            continue;
        }
        let code_like =
            raw.contains('_') || raw.chars().any(|ch| ch.is_ascii_uppercase()) || raw.len() >= 8;
        if !code_like {
            continue;
        }
        let token = raw.to_ascii_lowercase();
        if !tokens.iter().any(|existing| existing == &token) {
            tokens.push(token);
        }
    }
    tokens.truncate(12);
    tokens
}

fn issue_literals(task: &str) -> Vec<String> {
    let mut literals = Vec::new();
    for raw in task.split_whitespace() {
        let literal = raw.trim_matches(|ch: char| {
            matches!(
                ch,
                '`' | '\'' | '"' | ',' | ';' | ':' | '(' | ')' | '[' | ']'
            )
        });
        if literal.len() < 3 || literal.len() > 64 || !literal.chars().any(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        if !literals.iter().any(|existing| existing == literal) {
            literals.push(literal.to_string());
        }
    }
    literals.truncate(6);
    literals
}

fn source_compound(source: &str) -> String {
    let parts = path_parts(source);
    let parent = parts.iter().rev().nth(1).cloned().unwrap_or_default();
    let stem = stem(source);
    format!("{parent}{stem}")
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn generic_word(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "about"
            | "after"
            | "again"
            | "already"
            | "another"
            | "before"
            | "behavior"
            | "behaviour"
            | "because"
            | "class"
            | "comment"
            | "comments"
            | "content"
            | "current"
            | "description"
            | "different"
            | "error"
            | "example"
            | "expected"
            | "failure"
            | "function"
            | "issue"
            | "method"
            | "object"
            | "objects"
            | "output"
            | "possible"
            | "problem"
            | "should"
            | "solution"
            | "something"
            | "tests"
            | "testing"
            | "using"
            | "value"
            | "values"
            | "version"
            | "warning"
            | "warnings"
    )
}

fn test_path_rank(path: &str) -> u8 {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.starts_with("test_") {
        0
    } else if path.contains("/tests/") {
        1
    } else {
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn maps_by_generic_symbol_and_path_evidence() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("package/parser/tests")).unwrap();
        fs::write(
            repo.path().join("package/parser/format_value.py"),
            "def format_value(value):\n    return value\n",
        )
        .unwrap();
        fs::write(
            repo.path().join("package/parser/tests/test_format_value.py"),
            "from package.parser.format_value import format_value\ndef test_format_value():\n    assert format_value(1) == 1\n",
        )
        .unwrap();
        let map = build(
            repo.path().to_str().unwrap(),
            &["package/parser/format_value.py".to_string()],
            &[
                "package/parser/format_value.py".to_string(),
                "package/parser/tests/test_format_value.py".to_string(),
            ],
            "format_value should preserve compact output",
            4,
        );
        assert_eq!(
            map.candidates[0].path,
            "package/parser/tests/test_format_value.py"
        );
        assert_eq!(map.candidates[0].trust_tier, "source_exact");
        assert!(map.baseline_observations.is_empty());
    }

    #[test]
    fn does_not_need_repository_name_rules_for_cross_root_package_mapping() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("framework/db/backends/sqlite3")).unwrap();
        fs::create_dir_all(repo.path().join("tests/backends/sqlite")).unwrap();
        fs::write(
            repo.path().join("framework/db/backends/sqlite3/base.py"),
            "",
        )
        .unwrap();
        fs::write(
            repo.path().join("tests/backends/sqlite/tests.py"),
            "class SchemaTests: pass\n",
        )
        .unwrap();
        let map = build(
            repo.path().to_str().unwrap(),
            &["framework/db/backends/sqlite3/base.py".to_string()],
            &[
                "framework/db/backends/sqlite3/base.py".to_string(),
                "tests/backends/sqlite/tests.py".to_string(),
            ],
            "SQLite table names should not crash",
            4,
        );
        assert_eq!(map.candidates[0].path, "tests/backends/sqlite/tests.py");
    }

    #[test]
    fn source_compound_requires_package_affinity_for_same_named_tests() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("package/io/fits/tests")).unwrap();
        fs::create_dir_all(repo.path().join("package/cosmology/tests")).unwrap();
        fs::write(
            repo.path().join("package/io/fits/connect.py"),
            "def identify_fits(origin, *args):\n    return bool(args)\n",
        )
        .unwrap();
        fs::write(
            repo.path().join("package/io/fits/tests/test_connect.py"),
            "from package.io.fits.connect import identify_fits\ndef test_fits_connect(): assert identify_fits('read', object())\n",
        )
        .unwrap();
        fs::write(
            repo.path().join("package/cosmology/tests/test_connect.py"),
            "def test_connect(): pass\n",
        )
        .unwrap();

        let map = build(
            repo.path().to_str().unwrap(),
            &["package/io/fits/connect.py".to_string()],
            &[
                "package/io/fits/connect.py".to_string(),
                "package/io/fits/tests/test_connect.py".to_string(),
                "package/cosmology/tests/test_connect.py".to_string(),
            ],
            "FitsConnect should reject an empty positional argument list",
            4,
        );

        assert_eq!(
            map.candidates[0].path,
            "package/io/fits/tests/test_connect.py"
        );
        assert!(map.candidates[0].score > map.candidates[1].score);
        assert!(map.candidates[0].reason.contains("package affinity `fits`"));
        assert!(!map.candidates[1].reason.contains("source compound"));
    }

    #[test]
    fn preserves_compact_baseline_observations_in_the_map_artifact() {
        let mut map = CausalTestMap {
            schema_version: 2,
            artifact: "statewright.causal_test_map",
            source_paths: vec!["pkg/widget.py".to_string()],
            issue_tokens: vec!["widget".to_string()],
            candidates: Vec::new(),
            baseline_observations: Vec::new(),
        };
        map.record_baseline_observation(BaselineObservation {
            scope_desc: "DISCOVERY_TEST_FILES=tests/test_widget.py".to_string(),
            scope_keys: vec!["tests/test_widget.py".to_string()],
            signal: "passed".to_string(),
            relation: "regression".to_string(),
            fingerprint: String::new(),
            usable_for_candidate_comparison: true,
        });
        let rendered = serde_json::to_value(&map).unwrap();
        assert_eq!(rendered["baseline_observations"][0]["signal"], "passed");
    }

    #[test]
    fn task_specific_anchors_beat_repeated_generic_source_stem() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("lib/matplotlib/tests")).unwrap();
        fs::create_dir_all(repo.path().join("lib/mpl_toolkits/axisartist/tests")).unwrap();
        fs::write(
            repo.path().join("lib/matplotlib/axis.py"),
            "class Axis:\n    def set_labelcolor(self, labelcolor):\n        self.offsetText = labelcolor\n",
        )
        .unwrap();
        fs::write(
            repo.path().join("lib/matplotlib/tests/test_axes.py"),
            "def test_offset_text_labelcolor():\n    axis.offsetText.set_color(labelcolor)\n",
        )
        .unwrap();
        fs::write(
            repo.path()
                .join("lib/mpl_toolkits/axisartist/tests/test_axis_artist.py"),
            "\n".to_string() + &"Axis axis axis axis axis axis axis axis\n".repeat(8),
        )
        .unwrap();

        let map = build(
            repo.path().to_str().unwrap(),
            &["lib/matplotlib/axis.py".to_string()],
            &[
                "lib/matplotlib/axis.py".to_string(),
                "lib/matplotlib/tests/test_axes.py".to_string(),
                "lib/mpl_toolkits/axisartist/tests/test_axis_artist.py".to_string(),
            ],
            "offsetText must receive labelcolor when the Axis label color changes",
            4,
        );

        assert_eq!(map.candidates[0].path, "lib/matplotlib/tests/test_axes.py");
        assert!(map.candidates[0].reason.contains("issue/source identifier"));
    }

    #[test]
    fn support_module_under_tests_is_not_a_runnable_test() {
        assert!(!is_test_path("tests/prefetch_related/models.py"));
        assert!(is_test_path("tests/prefetch_related/tests.py"));
        assert!(is_test_path("pkg/tests/test_behavior.py"));
    }
}
