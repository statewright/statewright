use crate::{tools, validation_oracle};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A disposable worktree used only for validation. The model editing worktree is
/// never passed to a test command, so test-created files cannot alter the patch.
pub struct GitValidationSandbox {
    model_workdir: PathBuf,
    sandbox_workdir: PathBuf,
    base_commit: String,
    validation_cache: HashMap<String, String>,
}

const SCRATCH_REPRODUCER_DIR: &str = ".statewright-reproducer";

pub fn validation_worktree_parent(configured_root: Option<PathBuf>) -> PathBuf {
    configured_root.unwrap_or_else(|| std::env::temp_dir().join("statewright-validation-worktrees"))
}

impl GitValidationSandbox {
    pub fn create(
        model_workdir: impl AsRef<Path>,
        parent: impl AsRef<Path>,
    ) -> Result<Self, String> {
        let model_workdir = model_workdir.as_ref().to_path_buf();
        let parent = parent.as_ref();
        std::fs::create_dir_all(parent).map_err(|err| {
            format!(
                "create validation sandbox parent {}: {err}",
                parent.display()
            )
        })?;
        let base_commit = git_output(&model_workdir, &["rev-parse", "HEAD"])?;
        let suffix = format!(
            "statewright-validation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        );
        let sandbox_workdir = parent.join(suffix);
        let output = Command::new("git")
            .args(["worktree", "add", "--detach"])
            .arg(&sandbox_workdir)
            .arg(&base_commit)
            .current_dir(&model_workdir)
            .output()
            .map_err(|err| format!("create validation worktree: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "create validation worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let sandbox = Self {
            model_workdir,
            sandbox_workdir,
            base_commit,
            validation_cache: HashMap::new(),
        };
        sandbox.copy_protected_setup_artifacts()?;
        Ok(sandbox)
    }

    pub fn workdir(&self) -> &Path {
        &self.sandbox_workdir
    }

    pub fn validate(&mut self, scope: &Value) -> Result<String, String> {
        let patch = git_output_raw(&self.model_workdir, &["diff", "--binary"])?;
        let cache_key = validation_cache_key(&patch, scope);
        if let Some(output) = self.validation_cache.get(&cache_key) {
            println!("[VALIDATION_CACHE] HIT key={cache_key}");
            return Ok(output.clone());
        }
        self.reset_to_baseline()?;
        if !patch.trim().is_empty() {
            apply_patch(&self.sandbox_workdir, &patch)?;
        }
        let output = tools::run_test_direct_with_args(
            scope,
            self.sandbox_workdir.to_string_lossy().as_ref(),
        );
        self.validation_cache.insert(cache_key, output.clone());
        Ok(output)
    }

    /// Execute a model-authored scratch reproducer through the same solver-safe
    /// runner plan. The source is copied only into this disposable worktree;
    /// it is never added to the model worktree or prediction diff.
    pub fn validate_reproducer(
        &self,
        scratch_source: &Path,
        apply_candidate_patch: bool,
    ) -> Result<String, String> {
        self.reset_to_baseline()?;
        let relative = self.copy_scratch_reproducer(scratch_source)?;
        if apply_candidate_patch {
            let patch = git_output_raw(&self.model_workdir, &["diff", "--binary"])?;
            if !patch.trim().is_empty() {
                apply_patch(&self.sandbox_workdir, &patch)?;
            }
        }
        Ok(tools::run_test_direct_with_args(
            &serde_json::json!({"path": relative}),
            self.sandbox_workdir.to_string_lossy().as_ref(),
        ))
    }

    pub fn reset_to_baseline(&self) -> Result<(), String> {
        let output = Command::new("git")
            .args(["reset", "--hard", &self.base_commit])
            .current_dir(&self.sandbox_workdir)
            .output()
            .map_err(|err| format!("reset validation worktree: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "reset validation worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let scratch = self.sandbox_workdir.join(SCRATCH_REPRODUCER_DIR);
        if scratch.exists() {
            std::fs::remove_dir_all(&scratch).map_err(|err| {
                format!(
                    "clear scratch reproducer directory {}: {err}",
                    scratch.display()
                )
            })?;
        }
        self.copy_protected_setup_artifacts()
    }

    fn copy_scratch_reproducer(&self, scratch_source: &Path) -> Result<String, String> {
        if !scratch_source.is_file() {
            return Err(format!(
                "scratch reproducer source does not exist: {}",
                scratch_source.display()
            ));
        }
        let filename = scratch_source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                format!(
                    "scratch reproducer source has no valid filename: {}",
                    scratch_source.display()
                )
            })?;
        if !filename.ends_with(".py") || filename.contains('/') || filename.contains('\\') {
            return Err("scratch reproducer filename must be a plain .py filename".to_string());
        }
        let relative = format!("{SCRATCH_REPRODUCER_DIR}/{filename}");
        let destination = self.sandbox_workdir.join(&relative);
        let parent = destination
            .parent()
            .ok_or_else(|| "scratch reproducer destination has no parent".to_string())?;
        std::fs::create_dir_all(parent).map_err(|err| {
            format!(
                "create scratch reproducer parent {}: {err}",
                parent.display()
            )
        })?;
        std::fs::copy(scratch_source, &destination).map_err(|err| {
            format!(
                "copy scratch reproducer {} to {}: {err}",
                scratch_source.display(),
                destination.display()
            )
        })?;
        Ok(relative)
    }

    fn copy_protected_setup_artifacts(&self) -> Result<(), String> {
        let protected: HashSet<String> = validation_oracle::protected_setup_artifacts()
            .into_iter()
            .collect();
        for relative in protected {
            let source = self.model_workdir.join(&relative);
            if !source.is_file() {
                continue;
            }
            let destination = self.sandbox_workdir.join(&relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|err| {
                    format!(
                        "create protected artifact parent {}: {err}",
                        parent.display()
                    )
                })?;
            }
            std::fs::copy(&source, &destination).map_err(|err| {
                format!(
                    "copy protected setup artifact {} to {}: {err}",
                    source.display(),
                    destination.display()
                )
            })?;
        }
        Ok(())
    }

    pub fn teardown(self) -> Result<(), String> {
        let output = Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&self.sandbox_workdir)
            .current_dir(&self.model_workdir)
            .output()
            .map_err(|err| format!("remove validation worktree: {err}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "remove validation worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

fn validation_cache_key(patch: &str, scope: &Value) -> String {
    let scope = serde_json::to_string(scope).unwrap_or_else(|_| "{}".to_string());
    format!(
        "{}:{}",
        stable_hash(patch.as_bytes()),
        stable_hash(scope.as_bytes())
    )
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn git_output(workdir: &Path, args: &[&str]) -> Result<String, String> {
    Ok(git_output_raw(workdir, args)?.trim().to_string())
}

fn git_output_raw(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workdir)
        .output()
        .map_err(|err| format!("git {}: {err}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn apply_patch(workdir: &Path, patch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .args(["apply", "--whitespace=nowarn", "-"])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn git apply in validation worktree: {err}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "validation git apply stdin unavailable".to_string())?
        .write_all(patch.as_bytes())
        .map_err(|err| format!("write validation patch: {err}"))?;
    let output = child
        .wait_with_output()
        .map_err(|err| format!("wait validation git apply: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "apply candidate patch in validation worktree failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validation_worktree_parent_defaults_to_node_local_temp() {
        assert_eq!(
            validation_worktree_parent(None),
            std::env::temp_dir().join("statewright-validation-worktrees")
        );
        assert_eq!(
            validation_worktree_parent(Some(PathBuf::from("/custom/validation"))),
            PathBuf::from("/custom/validation")
        );
    }

    fn git(workdir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(workdir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn validation_runs_in_sandbox_without_touching_model_worktree() {
        let _guard = crate::tools::ENV_TEST_LOCK.lock().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init"]);
        git(
            repo.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(repo.path(), &["config", "user.name", "Test"]);
        fs::write(repo.path().join("source.py"), "VALUE = 1\n").unwrap();
        git(repo.path(), &["add", "source.py"]);
        git(repo.path(), &["commit", "-m", "baseline"]);
        fs::write(repo.path().join("source.py"), "VALUE = 2\n").unwrap();

        let plan = repo.path().join("solver-test-plan.json");
        fs::write(
            &plan,
            r#"{"schema_version":1,"runner":{"steps":[{"shell":"printf sandbox > test-side-effect.txt; printf OK","scope_position":"none"}]}}"#,
        )
        .unwrap();
        let prior_plan = std::env::var("SW_SOLVER_TEST_PLAN").ok();
        let prior_eval_image = std::env::var("SW_EVAL_IMAGE").ok();
        unsafe {
            std::env::set_var("SW_SOLVER_TEST_PLAN", &plan);
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let mut sandbox =
            GitValidationSandbox::create(repo.path(), repo.path().parent().unwrap()).unwrap();
        let output = sandbox.validate(&serde_json::json!({})).unwrap();
        assert!(output.contains("OK"), "{}", output);
        assert_eq!(
            fs::read_to_string(repo.path().join("source.py")).unwrap(),
            "VALUE = 2\n"
        );
        assert!(!repo.path().join("test-side-effect.txt").exists());
        sandbox.teardown().unwrap();

        unsafe {
            if let Some(value) = prior_plan {
                std::env::set_var("SW_SOLVER_TEST_PLAN", value);
            } else {
                std::env::remove_var("SW_SOLVER_TEST_PLAN");
            }
            if let Some(value) = prior_eval_image {
                std::env::set_var("SW_EVAL_IMAGE", value);
            } else {
                std::env::remove_var("SW_EVAL_IMAGE");
            }
        }
    }

    #[test]
    fn reproducer_baseline_and_candidate_are_isolated_from_model_worktree() {
        let _guard = crate::tools::ENV_TEST_LOCK.lock().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init"]);
        git(
            repo.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(repo.path(), &["config", "user.name", "Test"]);
        fs::write(repo.path().join("source.py"), "VALUE = 1\n").unwrap();
        git(repo.path(), &["add", "source.py"]);
        git(repo.path(), &["commit", "-m", "baseline"]);
        fs::write(repo.path().join("source.py"), "VALUE = 2\n").unwrap();

        let plan = repo.path().join("solver-test-plan.json");
        fs::write(
            &plan,
            r#"{"schema_version":1,"runner":{"steps":[{"shell":"python","scope_position":"append"}]}}"#,
        )
        .unwrap();
        let source = tempfile::NamedTempFile::with_suffix(".py").unwrap();
        fs::write(
            source.path(),
            "import source\nassert source.VALUE == 2, source.VALUE\n",
        )
        .unwrap();
        let prior_plan = std::env::var("SW_SOLVER_TEST_PLAN").ok();
        unsafe { std::env::set_var("SW_SOLVER_TEST_PLAN", &plan) };

        let sandbox =
            GitValidationSandbox::create(repo.path(), repo.path().parent().unwrap()).unwrap();
        let baseline = sandbox.validate_reproducer(source.path(), false).unwrap();
        let candidate = sandbox.validate_reproducer(source.path(), true).unwrap();
        assert_ne!(
            crate::repair_feedback::classify_output(&baseline),
            crate::repair_feedback::RepairSignalKind::Passed,
            "{baseline}"
        );
        assert_eq!(
            crate::repair_feedback::classify_output(&candidate),
            crate::repair_feedback::RepairSignalKind::Passed,
            "{candidate}"
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("source.py")).unwrap(),
            "VALUE = 2\n"
        );
        assert!(!repo.path().join(SCRATCH_REPRODUCER_DIR).exists());
        sandbox.teardown().unwrap();

        unsafe {
            if let Some(value) = prior_plan {
                std::env::set_var("SW_SOLVER_TEST_PLAN", value);
            } else {
                std::env::remove_var("SW_SOLVER_TEST_PLAN");
            }
        }
    }

    #[test]
    fn tool_run_test_routes_through_enabled_sandbox() {
        let _guard = crate::tools::ENV_TEST_LOCK.lock().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init"]);
        git(
            repo.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(repo.path(), &["config", "user.name", "Test"]);
        fs::write(repo.path().join("source.py"), "VALUE = 1\n").unwrap();
        git(repo.path(), &["add", "source.py"]);
        git(repo.path(), &["commit", "-m", "baseline"]);
        fs::write(repo.path().join("source.py"), "VALUE = 2\n").unwrap();

        let plan = repo.path().join("solver-test-plan.json");
        fs::write(
            &plan,
            r#"{"schema_version":1,"runner":{"steps":[{"shell":"printf sandbox > tool-side-effect.txt; printf OK","scope_position":"none"}]}}"#,
        )
        .unwrap();
        let prior_plan = std::env::var("SW_SOLVER_TEST_PLAN").ok();
        let prior_eval_image = std::env::var("SW_EVAL_IMAGE").ok();
        unsafe {
            std::env::set_var("SW_SOLVER_TEST_PLAN", &plan);
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let sandbox_guard = crate::tools::enable_validation_sandbox(
            repo.path().to_str().unwrap(),
            repo.path().parent().unwrap(),
        )
        .unwrap();
        let output = crate::tools::execute_tool(
            "run_test",
            &serde_json::json!({}),
            repo.path().to_str().unwrap(),
        );
        drop(sandbox_guard);

        assert!(output.contains("OK"), "{}", output);
        assert!(!repo.path().join("tool-side-effect.txt").exists());
        unsafe {
            if let Some(value) = prior_plan {
                std::env::set_var("SW_SOLVER_TEST_PLAN", value);
            } else {
                std::env::remove_var("SW_SOLVER_TEST_PLAN");
            }
            if let Some(value) = prior_eval_image {
                std::env::set_var("SW_EVAL_IMAGE", value);
            } else {
                std::env::remove_var("SW_EVAL_IMAGE");
            }
        }
    }

    #[test]
    fn prepared_snapshot_copies_runtime_artifacts_without_replaying_commands() {
        let _guard = crate::tools::ENV_TEST_LOCK.lock().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init"]);
        git(
            repo.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(repo.path(), &["config", "user.name", "Test"]);
        fs::write(repo.path().join("source.py"), "VALUE = 1\n").unwrap();
        git(repo.path(), &["add", "source.py"]);
        git(repo.path(), &["commit", "-m", "baseline"]);
        fs::write(repo.path().join("generated-runtime.so"), "prepared").unwrap();

        let setup = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            setup.path(),
            format!(
                "#!/bin/bash\ncd {}\nprintf replayed > replay-marker.txt\n",
                repo.path().display()
            ),
        )
        .unwrap();
        let manifest = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            manifest.path(),
            r#"{"protected_setup_artifacts":["generated-runtime.so"]}"#,
        )
        .unwrap();
        let prior_setup = std::env::var("SW_VALIDATION_SETUP_SCRIPT").ok();
        let prior_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        unsafe {
            std::env::set_var("SW_VALIDATION_SETUP_SCRIPT", setup.path());
            std::env::set_var("SW_VALIDATION_MANIFEST", manifest.path());
        }

        let sandbox =
            GitValidationSandbox::create(repo.path(), repo.path().parent().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(sandbox.workdir().join("generated-runtime.so")).unwrap(),
            "prepared"
        );
        assert!(!sandbox.workdir().join("replay-marker.txt").exists());
        assert!(!repo.path().join("replay-marker.txt").exists());
        sandbox.teardown().unwrap();

        unsafe {
            if let Some(value) = prior_setup {
                std::env::set_var("SW_VALIDATION_SETUP_SCRIPT", value);
            } else {
                std::env::remove_var("SW_VALIDATION_SETUP_SCRIPT");
            }
            if let Some(value) = prior_manifest {
                std::env::set_var("SW_VALIDATION_MANIFEST", value);
            } else {
                std::env::remove_var("SW_VALIDATION_MANIFEST");
            }
        }
    }

    #[test]
    fn validation_cache_key_is_patch_and_scope_specific() {
        let scope = serde_json::json!({"path": "tests/test_widget.py"});
        assert_eq!(
            validation_cache_key("patch-a", &scope),
            validation_cache_key("patch-a", &scope)
        );
        assert_ne!(
            validation_cache_key("patch-a", &scope),
            validation_cache_key("patch-b", &scope)
        );
        assert_ne!(
            validation_cache_key("patch-a", &scope),
            validation_cache_key(
                "patch-a",
                &serde_json::json!({"path": "tests/test_other.py"})
            )
        );
    }
}
