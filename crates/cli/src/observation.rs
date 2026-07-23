use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TOOL_OBSERVATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct ObservationFilter {
    enabled: bool,
    artifact_dir: Option<PathBuf>,
    line_budget: usize,
    min_chars: usize,
}

#[derive(Debug, Clone)]
pub struct FilteredObservation {
    pub displayed: String,
    pub raw_chars: usize,
    pub displayed_chars: usize,
    pub raw_artifact: Option<String>,
    pub filtered: bool,
}

impl ObservationFilter {
    pub fn from_env(model: &str) -> Self {
        let enabled = env_flag("SW_OBSERVATION_FILTER", true);
        let artifact_dir = std::env::var("SW_OBSERVATION_ARTIFACT_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let line_budget = std::env::var("SW_OBSERVATION_LINES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| default_line_budget(model))
            .clamp(20, 400);
        let min_chars = std::env::var("SW_OBSERVATION_MIN_CHARS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(3_000)
            .clamp(500, 100_000);

        Self {
            enabled,
            artifact_dir,
            line_budget,
            min_chars,
        }
    }

    pub fn filter(
        &self,
        state: &str,
        tool_name: &str,
        args: &Value,
        raw: &str,
        preferred_compact: Option<&str>,
        preserve_exact: bool,
    ) -> FilteredObservation {
        let raw_chars = raw.chars().count();
        if !self.enabled || !is_filterable_tool(tool_name) {
            return FilteredObservation::unchanged(raw, raw_chars);
        }

        let raw_artifact = self.write_raw_artifact(state, tool_name, args, raw);
        if preserve_exact {
            return FilteredObservation {
                displayed: raw.to_string(),
                raw_chars,
                displayed_chars: raw_chars,
                raw_artifact,
                filtered: false,
            };
        }
        let compact = preferred_compact
            .map(|value| value.to_string())
            .unwrap_or_else(|| compact_generic(raw, self.line_budget));
        let compact_chars = compact.chars().count();

        if raw_chars < self.min_chars && compact_chars >= raw_chars {
            return FilteredObservation {
                displayed: raw.to_string(),
                raw_chars,
                displayed_chars: raw_chars,
                raw_artifact,
                filtered: false,
            };
        }

        let mut header = format!(
            "[statewright:filtered-tool-output]\nstate: {}\ntool: {}\nraw_chars: {}\ndisplayed_chars: {}",
            state, tool_name, raw_chars, compact_chars
        );
        if let Some(path) = &raw_artifact {
            header.push_str(&format!("\nraw_artifact: {}", path));
        }
        header.push_str("\n---\n");
        let displayed = format!("{}{}", header, compact);
        let displayed_chars = displayed.chars().count();
        FilteredObservation {
            displayed,
            raw_chars,
            displayed_chars,
            raw_artifact,
            filtered: true,
        }
    }

    fn write_raw_artifact(
        &self,
        state: &str,
        tool_name: &str,
        args: &Value,
        raw: &str,
    ) -> Option<String> {
        let dir = self.artifact_dir.as_ref()?;
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
        let id = TOOL_OBSERVATION_ID.fetch_add(1, Ordering::Relaxed);
        let file_name = format!(
            "tool-{:06}-{}-{}.json",
            id,
            sanitize(state),
            sanitize(tool_name)
        );
        let path = dir.join(file_name);
        let payload = serde_json::json!({
            "state": state,
            "tool": tool_name,
            "args": args,
            "raw_chars": raw.chars().count(),
            "output": raw,
        });
        let bytes = match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => bytes,
            Err(_) => return None,
        };
        if std::fs::write(&path, bytes).is_err() {
            return None;
        }
        Some(path.to_string_lossy().to_string())
    }
}

impl FilteredObservation {
    fn unchanged(raw: &str, raw_chars: usize) -> Self {
        Self {
            displayed: raw.to_string(),
            raw_chars,
            displayed_chars: raw_chars,
            raw_artifact: None,
            filtered: false,
        }
    }
}

pub fn is_cacheable_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read_file"
            | "grep"
            | "find_files"
            | "list_directory"
            | "inspect_class"
            | "diff"
            | "run_test"
    )
}

pub fn is_filterable_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "run_test"
            | "grep"
            | "find_files"
            | "list_directory"
            | "inspect_class"
            | "diff"
            | "read_file"
    )
}

pub fn tool_cache_key(state: &str, tool_name: &str, args: &Value) -> String {
    format!(
        "{}:{}:{}",
        state,
        tool_name,
        serde_json::to_string(args).unwrap_or_default()
    )
}

fn compact_generic(raw: &str, line_budget: usize) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() <= line_budget {
        return raw.to_string();
    }

    let mut selected = Vec::new();
    for line in &lines {
        let trimmed = line.trim_end();
        if is_high_signal_line(trimmed) {
            selected.push(trimmed.chars().take(260).collect::<String>());
        }
        if selected.len() >= line_budget {
            break;
        }
    }

    if selected.is_empty() {
        let head = line_budget / 2;
        let tail = line_budget.saturating_sub(head);
        selected.extend(
            lines
                .iter()
                .take(head)
                .map(|line| line.chars().take(260).collect::<String>()),
        );
        selected.push(format!(
            "...[{} lines omitted by observation filter]...",
            lines.len().saturating_sub(line_budget)
        ));
        selected.extend(
            lines
                .iter()
                .skip(lines.len().saturating_sub(tail))
                .map(|line| line.chars().take(260).collect::<String>()),
        );
    }

    selected.join("\n")
}

fn is_high_signal_line(line: &str) -> bool {
    line.contains("FAILED")
        || line.contains("ERROR")
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
        || line.contains("warning")
        || line.contains("error")
        || line.contains("assert ")
        || line.trim_start().starts_with("E   ")
}

fn default_line_budget(model: &str) -> usize {
    let model = model.to_ascii_lowercase();
    if model.contains("70b") || model.contains("72b") {
        180
    } else if model.contains("30b") || model.contains("32b") || model.contains("34b") {
        140
    } else if model.contains("14b") || model.contains("20b") {
        110
    } else {
        80
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

fn sanitize(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    sanitized.truncate(48);
    sanitized.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_large_tool_output_and_preserves_signal() {
        let filter = ObservationFilter {
            enabled: true,
            artifact_dir: None,
            line_budget: 3,
            min_chars: 10,
        };
        let raw =
            "setup\nnoise\nFAILED tests/test_x.py::test_y\nmore noise\nE   AssertionError: nope\n";
        let filtered = filter.filter("testing", "run_test", &json!({}), raw, None, false);
        assert!(filtered.filtered);
        assert!(
            filtered
                .displayed
                .contains("FAILED tests/test_x.py::test_y")
        );
        assert!(filtered.displayed.contains("raw_chars:"));
        assert!(!filtered.displayed.contains("more noise"));
    }

    #[test]
    fn cache_key_includes_state_tool_and_args() {
        let a = tool_cache_key("planning", "grep", &json!({"pattern":"foo"}));
        let b = tool_cache_key("implementing", "grep", &json!({"pattern":"foo"}));
        assert_ne!(a, b);
    }

    #[test]
    fn exact_read_observation_is_not_compacted() {
        let filter = ObservationFilter {
            enabled: true,
            artifact_dir: None,
            line_budget: 3,
            min_chars: 10,
        };
        let raw = "first\nsecond\nthird\nfourth\nfifth\n";

        let filtered = filter.filter(
            "implementing",
            "read_file",
            &json!({"path":"src/lib.py"}),
            raw,
            None,
            true,
        );

        assert!(!filtered.filtered);
        assert_eq!(filtered.displayed, raw);
    }
}
