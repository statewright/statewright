use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SolverTestPlan {
    pub schema_version: u32,
    pub runner: SolverRunner,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SolverRunner {
    #[serde(default)]
    pub steps: Vec<SolverRunnerStep>,
    #[serde(default)]
    pub scope_adapter: ScopeAdapter,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SolverRunnerStep {
    pub shell: String,
    #[serde(default)]
    pub scope_position: ScopePosition,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopePosition {
    #[default]
    Append,
    None,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeAdapter {
    #[default]
    Raw,
    DjangoLabel,
}

pub fn load_from_env() -> Result<Option<SolverTestPlan>, String> {
    let Some(path) = std::env::var("SW_SOLVER_TEST_PLAN")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    load_from_path(&path).map(Some)
}

pub fn load_from_path(path: impl AsRef<Path>) -> Result<SolverTestPlan, String> {
    let path = path.as_ref();
    let content = std::fs::read_to_string(path)
        .map_err(|err| format!("solver test plan read path={} error={err}", path.display()))?;
    let plan: SolverTestPlan = serde_json::from_str(&content)
        .map_err(|err| format!("solver test plan parse path={} error={err}", path.display()))?;
    if plan.schema_version != 1 {
        return Err(format!(
            "solver test plan unsupported schema_version={}",
            plan.schema_version
        ));
    }
    if plan.runner.steps.is_empty() {
        return Err("solver test plan contains no runner steps".to_string());
    }
    if plan
        .runner
        .steps
        .iter()
        .any(|step| step.shell.trim().is_empty())
    {
        return Err("solver test plan contains an empty runner step".to_string());
    }
    Ok(plan)
}

pub fn shell_script_for_scope(plan: &SolverTestPlan, scope_args: &[String]) -> String {
    plan.runner
        .steps
        .iter()
        .map(|step| {
            let mut command = step.shell.trim().to_string();
            if step.scope_position == ScopePosition::Append {
                for arg in scope_args {
                    command.push(' ');
                    command.push_str(&shell_quote(arg));
                }
            }
            command
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

pub fn adapt_scope_args(plan: &SolverTestPlan, scope_args: &[String]) -> Vec<String> {
    match plan.runner.scope_adapter {
        ScopeAdapter::Raw => scope_args.to_vec(),
        ScopeAdapter::DjangoLabel => scope_args
            .iter()
            .map(|scope| django_label(scope))
            .collect(),
    }
}

/// Scratch reproducers are copied into the isolated validation worktree and
/// executed through the same TestSpec runner as public scopes. Label-oriented
/// runners cannot address that external file safely, so callers must retain a
/// direct-repair path instead of coercing its path into a repository label.
pub fn supports_scratch_reproducer(plan: &SolverTestPlan) -> bool {
    plan.runner.scope_adapter == ScopeAdapter::Raw
        && plan
            .runner
            .steps
            .iter()
            .any(|step| step.scope_position == ScopePosition::Append)
}

fn django_label(scope: &str) -> String {
    if scope.starts_with('-') || !scope.contains('/') {
        return scope.to_string();
    }
    let mut value = scope.trim_start_matches("./").replace('\\', "/");
    if let Some((path, test)) = value.split_once("::") {
        value = format!("{}.{}", path, test.replace("::", "."));
    }
    value = value.trim_end_matches(".py").to_string();
    value = value.trim_start_matches("tests/").to_string();
    value.replace('/', ".")
}

pub fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\\"'\\\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_multi_step_shell_semantics_and_scopes() {
        let plan: SolverTestPlan = serde_json::from_str(
            r#"{
                "schema_version": 1,
                "runner": {"steps": [
                    {"shell": "export MODE=fast", "scope_position": "none"},
                    {"shell": "python -m pytest -q", "scope_position": "append"}
                ]}
            }"#,
        )
        .unwrap();
        assert_eq!(
            shell_script_for_scope(&plan, &["tests/test value.py".to_string()]),
            "export MODE=fast && python -m pytest -q 'tests/test value.py'"
        );
    }

    #[test]
    fn quote_prevents_scope_shell_injection() {
        assert_eq!(shell_quote("tests/a.py; rm -rf /"), "'tests/a.py; rm -rf /'");
    }

    #[test]
    fn django_adapter_converts_test_paths_to_labels() {
        let plan: SolverTestPlan = serde_json::from_str(
            r#"{"schema_version":1,"runner":{"scope_adapter":"django_label","steps":[{"shell":"python tests/runtests.py","scope_position":"append"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            adapt_scope_args(&plan, &["tests/model_fields/test_imagefield.py".to_string()]),
            vec!["model_fields.test_imagefield".to_string()]
        );
    }

    #[test]
    fn scratch_reproducer_requires_raw_appended_scope() {
        let raw: SolverTestPlan = serde_json::from_str(
            r#"{"schema_version":1,"runner":{"steps":[{"shell":"pytest","scope_position":"append"}]}}"#,
        )
        .unwrap();
        assert!(supports_scratch_reproducer(&raw));

        let django: SolverTestPlan = serde_json::from_str(
            r#"{"schema_version":1,"runner":{"scope_adapter":"django_label","steps":[{"shell":"python tests/runtests.py","scope_position":"append"}]}}"#,
        )
        .unwrap();
        assert!(!supports_scratch_reproducer(&django));
    }

    #[test]
    fn rejects_empty_steps() {
        let path = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            path.path(),
            r#"{"schema_version":1,"runner":{"steps":[]}}"#,
        )
        .unwrap();
        assert!(load_from_path(path.path()).is_err());
    }
}
