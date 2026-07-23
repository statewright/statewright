use crate::{
    solver_test_plan, task_reproducer, test_runtime::GitValidationSandbox, validation_oracle,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct Snapshot {
    files: HashMap<String, Vec<u8>>,
}

impl Snapshot {
    pub fn len(&self) -> usize {
        self.files.len()
    }
}

/// File snapshots taken before implementing, isolated by repository root.
static SNAPSHOTS: std::sync::LazyLock<Mutex<HashMap<String, Snapshot>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static CANDIDATE_SNAPSHOTS: std::sync::LazyLock<Mutex<HashMap<String, Snapshot>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Edit locus gate: tracks consecutive edit failures per file.
/// After 3 consecutive failures on the same file, edit_line is blocked
/// until read_file is called for that file.
static EDIT_FAIL_COUNT: std::sync::LazyLock<Mutex<HashMap<String, usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static EDIT_BLOCKED: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));
static UNSCOPED_TEST_PROBE_USED: std::sync::LazyLock<Mutex<bool>> =
    std::sync::LazyLock::new(|| Mutex::new(false));
static VALIDATION_SANDBOX: std::sync::LazyLock<Mutex<Option<GitValidationSandbox>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));
static TASK_REPRODUCER_ISSUE: std::sync::LazyLock<Mutex<String>> =
    std::sync::LazyLock::new(|| Mutex::new(String::new()));
static ACTIVE_TASK_REPRODUCER: std::sync::LazyLock<Mutex<Option<ActiveTaskReproducer>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));
#[cfg(test)]
pub(crate) static ENV_TEST_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

pub struct ValidationSandboxGuard;

/// Whether the current process has a baseline-qualified scratch reproducer.
/// The answer is intentionally process-local: a child agent must qualify its
/// own reproducer instead of inheriting an unverified parent artifact.
pub fn has_qualified_task_reproducer() -> bool {
    ACTIVE_TASK_REPRODUCER
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

#[derive(Clone)]
struct ActiveTaskReproducer {
    source_path: PathBuf,
    qualified: task_reproducer::QualifiedReproducer,
    baseline_output: String,
    baseline_observation: validation_oracle::TestObservation,
}

impl Drop for ValidationSandboxGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = VALIDATION_SANDBOX.lock() {
            if let Some(sandbox) = slot.take() {
                if let Err(err) = sandbox.teardown() {
                    eprintln!("[VALIDATION_SANDBOX] teardown_failed {err}");
                }
            }
        }
    }
}

pub fn enable_validation_sandbox(
    model_workdir: &str,
    parent: &Path,
) -> Result<ValidationSandboxGuard, String> {
    let sandbox = GitValidationSandbox::create(model_workdir, parent)?;
    let mut slot = VALIDATION_SANDBOX
        .lock()
        .map_err(|_| "validation sandbox lock poisoned".to_string())?;
    if slot.is_some() {
        return Err("validation sandbox already enabled".to_string());
    }
    *slot = Some(sandbox);
    Ok(ValidationSandboxGuard)
}

pub fn set_task_reproducer_issue(task: &str) {
    if let Ok(mut issue) = TASK_REPRODUCER_ISSUE.lock() {
        *issue = task.to_string();
    }
}

fn should_ignore_snapshot_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let ignored_prefixes = [
        ".git/",
        ".venv/",
        "venv/",
        "__pycache__/",
        ".pytest_cache/",
        ".mypy_cache/",
        ".ruff_cache/",
        ".tox/",
        "node_modules/",
        "target/",
        "dist/",
        "build/",
    ];

    normalized == ".git"
        || ignored_prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        || normalized.contains("/__pycache__/")
        || normalized.contains("/.pytest_cache/")
        || normalized.contains("/node_modules/")
        || normalized.contains("/target/")
}

fn list_repo_files(workdir: &str) -> Vec<String> {
    if let Ok(output) = Command::new("git")
        .args([
            "-c",
            "core.quotePath=false",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(workdir)
        .output()
    {
        if output.status.success() {
            let files: Vec<String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .filter(|line| !should_ignore_snapshot_path(line))
                .map(|line| line.to_string())
                .collect();
            if !files.is_empty() {
                return files;
            }
        }
    }

    list_current_files(workdir)
}

fn list_current_files(workdir: &str) -> Vec<String> {
    let root = Path::new(workdir);
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let rel = match path.strip_prefix(root) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            if should_ignore_snapshot_path(&rel_str) {
                continue;
            }

            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                files.push(rel_str);
            }
        }
    }

    files.sort();
    files
}

fn snapshot_workdir(workdir: &str) -> Snapshot {
    let mut files = HashMap::new();

    for rel_path in list_repo_files(workdir) {
        let path = Path::new(workdir).join(&rel_path);
        if let Ok(content) = std::fs::read(&path) {
            files.insert(rel_path, content);
        }
    }

    Snapshot { files }
}

fn snapshot_key(workdir: &str) -> String {
    std::fs::canonicalize(workdir)
        .unwrap_or_else(|_| Path::new(workdir).to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn stored_snapshot(store: &Mutex<HashMap<String, Snapshot>>, workdir: &str) -> Option<Snapshot> {
    store.lock().unwrap().get(&snapshot_key(workdir)).cloned()
}

fn restore_snapshot_inner(workdir: &str, snapshot: &Snapshot) {
    let snapshot_paths: HashSet<&str> = snapshot.files.keys().map(|k| k.as_str()).collect();

    for rel_path in list_current_files(workdir) {
        if !snapshot_paths.contains(rel_path.as_str()) {
            if std::env::var("SW_EVAL_IMAGE").ok().as_deref() == Some("1")
                && crate::validation_oracle::is_protected_setup_artifact(&rel_path)
            {
                continue;
            }
            let path = Path::new(workdir).join(&rel_path);
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("  [RESTORE] Failed to remove {}: {}", rel_path, e);
            }
        }
    }

    for (rel_path, content) in &snapshot.files {
        let path = Path::new(workdir).join(rel_path);
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("  [RESTORE] Failed to create {}: {}", parent.display(), e);
                continue;
            }
        }
        if let Err(e) = std::fs::write(&path, content) {
            eprintln!("  [RESTORE] Failed to restore {}: {}", rel_path, e);
        }
    }
}

pub fn restore_from_snapshot(workdir: &str, snapshot: &Snapshot) {
    restore_snapshot_inner(workdir, snapshot);
}

/// Snapshot all files in the working directory. Returns owned map for restore.
pub fn snapshot_all(workdir: &str) -> Snapshot {
    snapshot_workdir(workdir)
}

/// Snapshot files into the internal store (for diff tool, called when entering implementing).
pub fn snapshot_files(workdir: &str) {
    let mut snaps = SNAPSHOTS.lock().unwrap();
    snaps.insert(snapshot_key(workdir), snapshot_workdir(workdir));
}

/// Snapshot files before a single candidate edit so failed auto-tests can revert only that edit.
pub fn snapshot_candidate(workdir: &str) {
    let mut snaps = CANDIDATE_SNAPSHOTS.lock().unwrap();
    snaps.insert(snapshot_key(workdir), snapshot_workdir(workdir));
}

pub fn restore_candidate_snapshot(workdir: &str) {
    if let Some(snapshot) = stored_snapshot(&CANDIDATE_SNAPSHOTS, workdir) {
        restore_snapshot_inner(workdir, &snapshot);
    }
}

/// Resolve a path argument: if the full path doesn't exist in workdir,
/// try the basename. Models hallucinate repo-structure paths like
/// "sympy/printing/pycode.py" when the file is just "pycode.py".
fn resolve_path(path: &str, workdir: &str) -> String {
    let full = Path::new(workdir).join(path);
    if full.exists() {
        return path.to_string();
    }
    // Try basename
    if let Some(basename) = Path::new(path).file_name() {
        let fallback = Path::new(workdir).join(basename);
        if fallback.exists() {
            return basename.to_string_lossy().to_string();
        }
    }
    // FIX 3: Fuzzy path resolution via git ls-files.
    // Model guesses "matplotlib/legend.py" but real path is "lib/matplotlib/legend.py".
    // Search for files matching the basename in the repo.
    if let Some(basename) = Path::new(path).file_name().and_then(|f| f.to_str()) {
        if let Ok(output) = Command::new("git")
            .args([
                "-c",
                "core.quotePath=false",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
            ])
            .current_dir(workdir)
            .output()
        {
            let files = String::from_utf8_lossy(&output.stdout);
            // Find files ending with the same basename
            let candidates: Vec<&str> = files.lines().filter(|f| f.ends_with(basename)).collect();
            if candidates.len() == 1 {
                // Unique match — use it
                return candidates[0].to_string();
            }
        }
    }
    // Return original — let the tool report the error
    path.to_string()
}

pub fn resolve_repo_path(path: &str, workdir: &str) -> String {
    resolve_path(path, workdir)
}

fn path_leaf(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
}

fn path_segments(path: &str) -> Vec<String> {
    Path::new(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => part.to_str().map(|s| s.to_string()),
            _ => None,
        })
        .collect()
}

fn filename_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(path)
        .to_string()
}

fn leaf_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    let mut curr = vec![0; b_chars.len() + 1];

    for (i, ca) in a_chars.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b_chars.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[b_chars.len()]
}

fn suggest_repo_paths(path: &str, workdir: &str) -> Vec<String> {
    let files = list_current_files(workdir);
    if files.is_empty() {
        return Vec::new();
    }

    let normalized = path.replace('\\', "/");
    let target_leaf = match path_leaf(&normalized) {
        Some(leaf) if !leaf.is_empty() => leaf,
        _ => return Vec::new(),
    };
    let target_segments = path_segments(&normalized);
    let target_stem = filename_stem(&target_leaf);
    let requested_test_path = target_segments
        .iter()
        .any(|segment| segment.contains("test") || segment == "tests" || segment == "testing");
    let mut scored: Vec<(usize, String)> = Vec::new();

    for candidate in files {
        let candidate_leaf = match path_leaf(&candidate) {
            Some(leaf) => leaf,
            None => continue,
        };
        let candidate_stem = filename_stem(&candidate_leaf);
        let candidate_segments = path_segments(&candidate);
        let suffix_matches = target_segments
            .iter()
            .rev()
            .zip(candidate_segments.iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let segment_overlap = target_segments
            .iter()
            .filter(|segment| {
                candidate_segments
                    .iter()
                    .any(|candidate| candidate == *segment)
            })
            .count();
        let candidate_test_path = candidate_segments
            .iter()
            .any(|segment| segment.contains("test") || segment == "tests" || segment == "testing");

        let mut score = suffix_matches * 100 + segment_overlap * 20;
        if candidate_leaf == target_leaf {
            score += 1000;
        } else if candidate_stem == target_stem {
            score += 700;
        } else if candidate_leaf.contains(&target_leaf) || target_leaf.contains(&candidate_leaf) {
            score += 300;
        } else {
            let distance = leaf_distance(&candidate_leaf, &target_leaf);
            if distance <= 2 {
                score += 220usize.saturating_sub(distance * 40);
            }
        }
        if requested_test_path == candidate_test_path {
            score += 25;
        }
        score += candidate_segments.len().saturating_sub(1);

        if score >= 180 {
            scored.push((score, candidate));
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, path)| path).take(8).collect()
}

fn write_blocked_message(path: &str, workdir: &str) -> String {
    let suggestions = suggest_repo_paths(path, workdir);
    if suggestions.is_empty() {
        format!(
            "BLOCKED: '{}' is not an existing file in the repository. Locate the correct existing file with find_files/grep/list_directory before editing. If the task truly requires a new file, use create_file with a path under an existing repository directory.",
            path
        )
    } else {
        format!(
            "BLOCKED: '{}' is not an existing file in the repository. Closest leaf matches: {}. If you meant the same filename in another package, pick one of those paths. Otherwise use find_files/grep/list_directory to locate the correct file before editing.",
            path,
            suggestions.join(", ")
        )
    }
}

pub fn repo_path_exists_exact(path: &str, workdir: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains("..") {
        return false;
    }
    let full_path = Path::new(workdir).join(path);
    full_path.exists() && full_path.is_file()
}

pub fn repo_path_missing_diagnostic(path: &str, workdir: &str) -> String {
    write_blocked_message(path, workdir)
}

fn create_blocked_message(path: &str) -> String {
    format!(
        "BLOCKED: cannot create '{}'. New files must be placed under an existing repository directory. Use list_directory/find_files to locate the correct package or test directory first.",
        path
    )
}

pub fn validate_existing_repo_file(
    path: &str,
    workdir: &str,
) -> Result<std::path::PathBuf, String> {
    if path.starts_with('/') {
        let suggestions = suggest_repo_paths(path, workdir);
        if suggestions.is_empty() {
            return Err("error: path traversal detected".into());
        }
        return Err(format!(
            "BLOCKED: '{}' is outside the repository. Closest leaf matches: {}. Use one of those repository-relative paths.",
            path,
            suggestions.join(", ")
        ));
    }
    if path.contains("..") {
        return Err("error: path traversal detected".into());
    }

    let full_path = Path::new(workdir).join(path);
    if !full_path.exists() || !full_path.is_file() {
        return Err(write_blocked_message(path, workdir));
    }

    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("error resolving '{}': {}", path, e))?;
    let workdir_canonical = Path::new(workdir)
        .canonicalize()
        .map_err(|e| format!("error resolving workdir: {}", e))?;
    if !canonical.starts_with(&workdir_canonical) {
        return Err("error: path traversal detected".into());
    }

    Ok(canonical)
}

pub fn validate_new_repo_file(path: &str, workdir: &str) -> Result<std::path::PathBuf, String> {
    if path.contains("..") || path.starts_with('/') {
        return Err("error: path traversal detected".into());
    }

    let full_path = Path::new(workdir).join(path);
    if full_path.exists() {
        return Err(format!(
            "BLOCKED: '{}' already exists. Use edit_line/edit_block/patch_file to modify it.",
            path
        ));
    }

    let parent = full_path
        .parent()
        .ok_or_else(|| create_blocked_message(path))?;
    if !parent.exists() || !parent.is_dir() {
        return Err(create_blocked_message(path));
    }

    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("error resolving parent for '{}': {}", path, e))?;
    let workdir_canonical = Path::new(workdir)
        .canonicalize()
        .map_err(|e| format!("error resolving workdir: {}", e))?;
    if !parent_canonical.starts_with(&workdir_canonical) {
        return Err("error: path traversal detected".into());
    }

    Ok(full_path)
}

/// Resolve unique path suggestions only for read-oriented tools. Mutations must
/// name the exact repository path so a hallucinated path cannot edit another file.
fn resolve_args_paths(name: &str, args: &Value, workdir: &str) -> Value {
    let mut args = args.clone();
    if !matches!(
        name,
        "read_file" | "list_directory" | "grep" | "find_files" | "inspect_class"
    ) {
        return args;
    }
    if let Some(obj) = args.as_object_mut() {
        if let Some(p) = obj
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            obj.insert("path".to_string(), Value::String(resolve_path(&p, workdir)));
        }
        if let Some(p) = obj
            .get("file")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            obj.insert("file".to_string(), Value::String(resolve_path(&p, workdir)));
        }
    }
    args
}

/// Execute a tool call against the working directory.
pub fn execute_tool(name: &str, args: &Value, workdir: &str) -> String {
    let args = &resolve_args_paths(name, args, workdir);
    match name {
        "read_file" => read_file(args, workdir),
        "write_file" => write_file(args, workdir),
        "list_directory" => list_directory(args, workdir),
        "run_test" => {
            let started = std::time::Instant::now();
            let output = run_test_with_sandbox(args, workdir);
            crate::validation_oracle::record_test_execution(
                args,
                workdir,
                &output,
                started.elapsed(),
            );
            output
        }
        "write_task_reproducer" => write_task_reproducer(args, workdir),
        "run_task_reproducer" => run_task_reproducer(workdir),
        "grep" => grep(args, workdir),
        "diff" => diff(args, workdir),
        "edit_line" => edit_line(args, workdir),
        "edit_block" => edit_block(args, workdir),
        "patch_file" => patch_file(args, workdir),
        "apply_patch" => apply_patch(args, workdir),
        "insert_between" => insert_between(args, workdir),
        "find_files" => find_files(args, workdir),
        "inspect_class" => inspect_class(args, workdir),
        "create_file" => create_file(args, workdir),
        _ => format!("unknown tool: {}", name),
    }
}

fn write_task_reproducer(args: &Value, workdir: &str) -> String {
    let source = match args.get("source").and_then(Value::as_str) {
        Some(source) => source,
        None => return "ERROR: write_task_reproducer requires a source string.".to_string(),
    };
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("test_task_reproducer.py");
    if let Some(reason) = task_reproducer::source_preflight_error(source) {
        return format!(
            "[TASK_REPRODUCER] REJECTED reason={}\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\nCorrect the scratch source before retrying, or continue with direct repair.\n",
            reason
        );
    }
    let plan = match solver_test_plan::load_from_env() {
        Ok(Some(plan)) if solver_test_plan::supports_scratch_reproducer(&plan) => plan,
        Ok(Some(_)) => {
            return "[TASK_REPRODUCER] UNAVAILABLE reason=solver_runner_does_not_support_external_path_scope\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n".to_string();
        }
        Ok(None) => {
            return "[TASK_REPRODUCER] UNAVAILABLE reason=solver_safe_test_plan_missing\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n".to_string();
        }
        Err(err) => {
            return format!(
                "[TASK_REPRODUCER] UNAVAILABLE reason=solver_safe_test_plan_invalid error={}\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n",
                err
            );
        }
    };
    let root = match task_reproducer_root(workdir) {
        Ok(root) => root,
        Err(err) => {
            return format!(
                "[TASK_REPRODUCER] UNAVAILABLE reason=scratch_root_invalid error={}\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n",
                err
            );
        }
    };
    let source_path = match task_reproducer::write_scratch(&root, name, source) {
        Ok(path) => path,
        Err(err) => return format!("[TASK_REPRODUCER] REJECTED reason={err}\n"),
    };
    let issue = TASK_REPRODUCER_ISSUE
        .lock()
        .map(|issue| issue.clone())
        .unwrap_or_default();
    let issue_anchors = task_reproducer::issue_anchors_from_task(&issue);
    let started = Instant::now();
    let baseline_output = match validate_task_reproducer(&source_path, false) {
        Ok(output) => output,
        Err(err) => {
            return format!(
                "[TASK_REPRODUCER] UNAVAILABLE reason=validation_sandbox error={}\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n",
                err
            );
        }
    };
    let elapsed = started.elapsed();
    let virtual_path = format!(".statewright-reproducer/{name}");
    validation_oracle::record_task_reproducer_execution(
        validation_oracle::TestPhase::Baseline,
        vec![virtual_path.clone()],
        &baseline_output,
        elapsed,
    );
    let qualification =
        task_reproducer::qualify(&virtual_path, source, &issue_anchors, &baseline_output);
    let task_reproducer::ReproducerQualification::Qualified(qualified) = qualification else {
        let task_reproducer::ReproducerQualification::Rejected { reason } = qualification else {
            unreachable!();
        };
        return format!(
            "[TASK_REPRODUCER] REJECTED reason={}\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n",
            reason
        );
    };
    let baseline_observation =
        validation_oracle::observation_from_output(&baseline_output, elapsed);
    let active = ActiveTaskReproducer {
        source_path,
        qualified: qualified.clone(),
        baseline_output,
        baseline_observation,
    };
    if let Ok(mut slot) = ACTIVE_TASK_REPRODUCER.lock() {
        *slot = Some(active.clone());
    } else {
        return "[TASK_REPRODUCER] UNAVAILABLE reason=reproducer_state_lock\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n".to_string();
    }
    persist_task_reproducer(&root, &active, plan.schema_version);
    format!(
        "[TASK_REPRODUCER] QUALIFIED path={} anchors={} baseline_kind={} baseline_fingerprint={}\nSW_TASK_REPRODUCER_STATUS=qualified\nUse run_task_reproducer after each production edit. It runs only in the isolated validation worktree.\n",
        qualified.path,
        if qualified.issue_anchors.is_empty() {
            "none".to_string()
        } else {
            qualified.issue_anchors.join(",")
        },
        active.baseline_observation.kind,
        active.baseline_observation.fingerprint,
    )
}

fn run_task_reproducer(workdir: &str) -> String {
    let active = match ACTIVE_TASK_REPRODUCER.lock() {
        Ok(slot) => slot.clone(),
        Err(_) => {
            return "[TASK_REPRODUCER] UNAVAILABLE reason=reproducer_state_lock\n".to_string();
        }
    };
    let Some(active) = active else {
        return "[TASK_REPRODUCER] UNAVAILABLE reason=no_qualified_reproducer\nSW_TASK_REPRODUCER_STATUS=no_causal_oracle\n".to_string();
    };
    let started = Instant::now();
    let candidate_output = match validate_task_reproducer(&active.source_path, true) {
        Ok(output) => output,
        Err(err) => {
            return format!(
                "[TASK_REPRODUCER] UNAVAILABLE reason=validation_sandbox error={err}\n"
            );
        }
    };
    let elapsed = started.elapsed();
    validation_oracle::record_task_reproducer_execution(
        validation_oracle::TestPhase::Candidate,
        vec![active.qualified.path.clone()],
        &candidate_output,
        elapsed,
    );
    let candidate = validation_oracle::observation_from_output(&candidate_output, elapsed);
    let baseline_kind = crate::repair_feedback::classify_output(&active.baseline_output);
    let candidate_kind = crate::repair_feedback::classify_output(&candidate_output);
    let delta = validation_oracle::delta_for_observations(
        validation_oracle::EvidenceProvenance::TaskReproducer,
        baseline_kind,
        candidate_kind,
        &active.baseline_observation.fingerprint,
        &candidate.fingerprint,
    );
    let evidence = validation_oracle::TestEvidence {
        evidence_id: format!("task-reproducer-{}", patch_fingerprint(workdir)),
        provenance: validation_oracle::EvidenceProvenance::TaskReproducer,
        scope: vec![active.qualified.path.clone()],
        baseline: active.baseline_observation.clone(),
        candidate: candidate.clone(),
        delta,
        runtime_fingerprint: "solver-safe-test-plan".to_string(),
        patch_hash: patch_fingerprint(workdir),
    };
    validation_oracle::record_test_evidence(&evidence);
    format!(
        "[TASK_REPRODUCER] CANDIDATE delta={} baseline_kind={} candidate_kind={} fingerprint={}\nSW_TASK_REPRODUCER_DELTA={}\n{}",
        evidence.delta.as_str(),
        evidence.baseline.kind,
        evidence.candidate.kind,
        evidence.candidate.fingerprint,
        evidence.delta.as_str(),
        candidate_output
    )
}

fn validate_task_reproducer(
    source_path: &Path,
    apply_candidate_patch: bool,
) -> Result<String, String> {
    let slot = VALIDATION_SANDBOX
        .lock()
        .map_err(|_| "validation sandbox lock poisoned".to_string())?;
    let sandbox = slot
        .as_ref()
        .ok_or_else(|| "validation sandbox is not enabled".to_string())?;
    sandbox.validate_reproducer(source_path, apply_candidate_patch)
}

fn task_reproducer_root(workdir: &str) -> Result<PathBuf, String> {
    let root = std::env::var("SW_TASK_REPRODUCER_DIR")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("SW_ARTIFACT_DIR")
                .ok()
                .filter(|path| !path.trim().is_empty())
                .map(|path| PathBuf::from(path).join("task-reproducers"))
        })
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "statewright-task-reproducers-{}",
                std::process::id()
            ))
        });
    if !root.is_absolute() {
        return Err("scratch reproducer root must be absolute".to_string());
    }
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("create scratch reproducer root {}: {err}", root.display()))?;
    let canonical_root = std::fs::canonicalize(&root).map_err(|err| {
        format!(
            "canonicalize scratch reproducer root {}: {err}",
            root.display()
        )
    })?;
    let canonical_workdir = std::fs::canonicalize(workdir)
        .map_err(|err| format!("canonicalize model workdir {workdir}: {err}"))?;
    if canonical_root.starts_with(&canonical_workdir) {
        return Err("scratch reproducer root may not be inside the model worktree".to_string());
    }
    Ok(canonical_root)
}

pub fn patch_fingerprint(workdir: &str) -> String {
    let bytes = Command::new("git")
        .args(["diff", "--binary"])
        .current_dir(workdir)
        .output()
        .map(|output| output.stdout)
        .unwrap_or_default();
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64-{hash:016x}")
}

fn persist_task_reproducer(root: &Path, active: &ActiveTaskReproducer, plan_schema_version: u32) {
    let payload = serde_json::json!({
        "schema_version": 1,
        "artifact": "statewright.task_reproducer",
        "qualified": task_reproducer::stored(&active.qualified),
        "baseline": active.baseline_observation,
        "solver_test_plan_schema_version": plan_schema_version,
    });
    let path = root.join("task-reproducer.json");
    if let Err(err) = std::fs::write(
        &path,
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()),
    ) {
        eprintln!(
            "[TASK_REPRODUCER] persist failed path={} error={err}",
            path.display()
        );
    }
}

fn read_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };

    let full_path = Path::new(workdir).join(path);

    let canonical = match full_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            if !full_path.exists() {
                return format!(
                    "File '{}' does not exist. Use find_files/grep/list_directory to locate the correct repository file before reading or editing.",
                    path
                );
            }
            return format!("error reading '{}': {}", path, e);
        }
    };
    let workdir_canonical = match Path::new(workdir).canonicalize() {
        Ok(p) => p,
        Err(e) => return format!("error resolving workdir: {}", e),
    };
    if !canonical.starts_with(&workdir_canonical) {
        return "error: path traversal detected".into();
    }

    let start_line = args
        .get("start_line")
        .or_else(|| args.get("line_start"))
        .and_then(|l| l.as_u64())
        .map(|l| l as usize);
    let end_line = args
        .get("end_line")
        .or_else(|| args.get("line_end"))
        .and_then(|l| l.as_u64())
        .map(|l| l as usize);

    match std::fs::read_to_string(&canonical) {
        Ok(content) => {
            // Clear edit locus gate — reading the file re-grounds the model
            if let Ok(mut blocked) = EDIT_BLOCKED.lock() {
                blocked.remove(path);
            }
            if let Ok(mut counts) = EDIT_FAIL_COUNT.lock() {
                counts.remove(path);
            }

            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();

            match (start_line, end_line) {
                (Some(start), Some(end)) => {
                    let s = start.saturating_sub(1).min(total);
                    let e = end.min(total);
                    let selected: Vec<String> = lines[s..e]
                        .iter()
                        .enumerate()
                        .map(|(i, l)| format!("{:>4}: {}", s + i + 1, l))
                        .collect();
                    format!(
                        "(lines {}-{} of {})\n{}",
                        s + 1,
                        e,
                        total,
                        selected.join("\n")
                    )
                }
                (Some(start), None) => {
                    let s = start.saturating_sub(1).min(total);
                    let selected: Vec<String> = lines[s..]
                        .iter()
                        .enumerate()
                        .map(|(i, l)| format!("{:>4}: {}", s + i + 1, l))
                        .collect();
                    format!(
                        "(lines {}-{} of {})\n{}",
                        s + 1,
                        total,
                        total,
                        selected.join("\n")
                    )
                }
                _ => {
                    // No range — return with line numbers for large files
                    if total > 100 {
                        let numbered: Vec<String> = lines
                            .iter()
                            .enumerate()
                            .map(|(i, l)| format!("{:>4}: {}", i + 1, l))
                            .collect();
                        format!("({} lines)\n{}", total, numbered.join("\n"))
                    } else {
                        content
                    }
                }
            }
        }
        Err(e) => format!("error reading '{}': {}", path, e),
    }
}

fn normalize_edit_match_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn line_similarity(a: &str, b: &str) -> f64 {
    let a = normalize_edit_match_line(a);
    let b = normalize_edit_match_line(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let a_chars: Vec<char> = a.chars().take(240).collect();
    let b_chars: Vec<char> = b.chars().take(240).collect();
    let mut prev = vec![0usize; b_chars.len() + 1];
    let mut curr = vec![0usize; b_chars.len() + 1];
    for a_ch in &a_chars {
        for (j, b_ch) in b_chars.iter().enumerate() {
            curr[j + 1] = if a_ch == b_ch {
                prev[j] + 1
            } else {
                curr[j].max(prev[j + 1])
            };
        }
        std::mem::swap(&mut prev, &mut curr);
        curr.fill(0);
    }
    let lcs = prev[b_chars.len()] as f64;
    (2.0 * lcs) / ((a_chars.len() + b_chars.len()) as f64)
}

fn best_fuzzy_line_match(lines: &[&str], old: &str, hint_line: Option<usize>) -> Option<usize> {
    let old_norm = normalize_edit_match_line(old);
    if old_norm.len() < 12 {
        return None;
    }

    let candidate_range: Box<dyn Iterator<Item = usize>> = if let Some(hint) = hint_line {
        let start = hint.saturating_sub(4);
        let end = (hint + 3).min(lines.len());
        Box::new(start..end)
    } else {
        Box::new(0..lines.len())
    };

    let mut scored: Vec<(usize, f64)> = candidate_range
        .filter_map(|idx| {
            let line = lines.get(idx)?;
            let line_norm = normalize_edit_match_line(line);
            if line_norm.len() < 8 {
                return None;
            }
            let score = line_similarity(&old_norm, &line_norm);
            (score >= 0.90).then_some((idx, score))
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let (best_idx, best_score) = *scored.first()?;
    if hint_line.is_some() {
        return Some(best_idx);
    }
    let second = scored.get(1).map(|(_, score)| *score).unwrap_or(0.0);
    (best_score >= 0.94 && best_score - second >= 0.04).then_some(best_idx)
}

fn write_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };
    let content = match args.get("content").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return "error: missing 'content' argument".into(),
    };

    let full_path = match validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => return msg,
    };

    match std::fs::write(&full_path, content) {
        Ok(()) => format!("wrote {} bytes to {}", content.len(), path),
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Phase 1 of two-phase file write. Validates path and parent directory,
/// returns a sentinel that the harness intercepts to trigger the content phase.
/// The harness prompts the model for raw file content in a separate LLM call.
fn create_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };

    if let Err(msg) = validate_new_repo_file(path, workdir) {
        return msg;
    }

    // Return sentinel — the harness detects this and triggers content phase
    format!("CREATE_FILE_READY:{}", path)
}

/// Strip markdown code fences from model output.
/// Models sometimes wrap raw content in ```python ... ``` even when told not to.
pub fn strip_code_fences(content: &str) -> String {
    let trimmed = content.trim();

    // Check for opening fence (``` or ```lang)
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }

    // Find end of first line (the opening fence line)
    let first_newline = match trimmed.find('\n') {
        Some(i) => i,
        None => return trimmed.to_string(),
    };

    let body = &trimmed[first_newline + 1..];

    // Strip closing fence
    if let Some(close_pos) = body.rfind("\n```") {
        body[..close_pos].to_string()
    } else if body.ends_with("```") {
        body[..body.len() - 3].trim_end().to_string()
    } else {
        // No closing fence — take everything after opening fence
        body.to_string()
    }
}

fn list_directory(args: &Value, workdir: &str) -> String {
    let subdir = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let full_path = Path::new(workdir).join(subdir);

    match std::fs::read_dir(&full_path) {
        Ok(entries) => {
            let mut files: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let ft = e.file_type().ok();
                    if ft.as_ref().is_some_and(|t| t.is_dir()) {
                        format!("{}/", name)
                    } else {
                        name
                    }
                })
                .collect();
            files.sort();
            files.join("\n")
        }
        Err(e) => format!("error listing '{}': {}", subdir, e),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn django_runtests_target(target: &str) -> String {
    let trimmed = target.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return target.to_string();
    }

    let (path_part, node_part) = trimmed
        .split_once("::")
        .map(|(path, node)| (path, Some(node)))
        .unwrap_or((trimmed, None));
    let path_part = path_part
        .rsplit_once(':')
        .filter(|(_, suffix)| suffix.chars().all(|ch| ch.is_ascii_digit()))
        .map(|(path, _)| path)
        .unwrap_or(path_part);
    let mut normalized = path_part.replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }

    if !normalized.starts_with("tests/") {
        return target.to_string();
    }

    let mut label = normalized
        .trim_start_matches("tests/")
        .trim_end_matches(".py")
        .replace('/', ".");
    if let Some(node) = node_part {
        for part in node.split("::") {
            let clean = part.trim();
            if !clean.is_empty()
                && clean
                    .chars()
                    .all(|ch| ch == '_' || ch == '.' || ch.is_ascii_alphanumeric())
            {
                label.push('.');
                label.push_str(clean);
            }
        }
    }
    label
}

fn test_failure_stream_signal(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("FAIL: ")
        || trimmed.starts_with("ERROR: ")
        || trimmed.starts_with("FAILED ")
        || trimmed.contains(" FAILED ")
        || trimmed.contains("FAILED (")
        || trimmed.contains("Traceback (most recent call last)")
        || trimmed.contains("AssertionError")
        || trimmed.contains("ImportError")
        || trimmed.contains("ModuleNotFoundError")
        || trimmed.contains("NameError")
        || trimmed.contains("ValueError")
        || trimmed.contains("TypeError")
        || trimmed.contains("SyntaxError")
        || trimmed.contains("IndentationError")
        || trimmed.starts_with("E   ")
}

fn format_test_command_output(
    _lang: &str,
    run_cmd: &str,
    run_args: &[String],
    combined: &str,
    exit_code: i32,
    timed_out: bool,
    early_stopped: bool,
    unscoped_probe: bool,
    elapsed_ms: u128,
) -> String {
    let requested_can_complete =
        std::env::var("SW_TEST_CAN_COMPLETE").unwrap_or_else(|_| "1".to_string());
    let scope_authority = test_scope_authority(unscoped_probe, &requested_can_complete);
    let scope_trusted = if scope_authority == "trusted" {
        "1"
    } else {
        "0"
    };
    let can_complete = if scope_authority == "trusted" {
        requested_can_complete.as_str()
    } else {
        "0"
    };
    let patch_status =
        std::env::var("SW_TEST_PATCH_STATUS").unwrap_or_else(|_| "unknown".to_string());
    let header = format!(
        "SW_TEST_EXIT_CODE={}\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY={}\nSW_TEST_SCOPE_TRUSTED={}\nSW_TEST_CAN_COMPLETE={}\nSW_TEST_PATCH_STATUS={}\nSW_TEST_COMMAND={} {:?}\nSW_TEST_TIMED_OUT={}\nSW_TEST_EARLY_STOPPED={}\nSW_TEST_ELAPSED_MS={}\n---\n",
        exit_code,
        scope_authority,
        scope_trusted,
        can_complete,
        patch_status,
        run_cmd,
        run_args,
        if timed_out { 1 } else { 0 },
        if early_stopped { 1 } else { 0 },
        elapsed_ms
    );

    let env_miss = [
        "No module named pytest",
        "No module named 'pytest'",
        "pytest: command not found",
        "command not found: pytest",
        "No module named unittest",
        "No module named 'unittest'",
    ];
    if env_miss.iter().any(|p| combined.contains(p)) {
        return format!(
            "TEST_ENV_UNAVAILABLE: {}\nSW_TEST_EXIT_CODE={}\nSW_TEST_ENV_UNAVAILABLE=1\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\n",
            &combined[..combined.len().min(500)],
            exit_code
        );
    }

    if combined.len() > 8000 {
        let truncated = &combined[..4000];
        let tail = &combined[combined.len() - 3000..];
        format!(
            "{}{}...\n[truncated {} bytes]\n...{}",
            header,
            truncated,
            combined.len() - 7000,
            tail
        )
    } else {
        format!("{}{}", header, combined)
    }
}

fn test_scope_authority(unscoped_probe: bool, requested_can_complete: &str) -> String {
    if unscoped_probe {
        return "untrusted".to_string();
    }
    if requested_can_complete.trim() == "0" {
        return "feedback".to_string();
    }
    if let Ok(authority) = std::env::var("SW_TEST_SCOPE_AUTHORITY") {
        match authority.trim() {
            "trusted" | "feedback" | "untrusted" => return authority.trim().to_string(),
            _ => return "untrusted".to_string(),
        }
    }
    if let Ok(trusted) = std::env::var("SW_TEST_SCOPE_TRUSTED") {
        return if trusted.trim() == "0" {
            "untrusted".to_string()
        } else {
            "trusted".to_string()
        };
    }
    if std::env::var("SW_EVAL_IMAGE").ok().as_deref() == Some("1") {
        "untrusted".to_string()
    } else {
        "trusted".to_string()
    }
}

fn format_test_runner_unavailable(
    lang: &str,
    err: &std::io::Error,
    run_cmd: &str,
    run_args: &[String],
) -> String {
    format!(
        "TEST_ENV_UNAVAILABLE: error running tests ({lang}): {err} -- cmd: {run_cmd} {run_args:?}\n\
SW_TEST_EXIT_CODE=-1\n\
SW_TEST_ENV_UNAVAILABLE=1\n\
SW_TEST_SCOPE_AUTHORITY=untrusted\n\
SW_TEST_SCOPE_TRUSTED=0\n\
SW_TEST_CAN_COMPLETE=0\n\
SW_TEST_COMMAND={run_cmd} {run_args:?}\n\
SW_TEST_TIMED_OUT=0\n\
SW_TEST_EARLY_STOPPED=0\n"
    )
}

fn format_test_setup_unavailable(message: &str, run_cmd: &str, run_args: &[String]) -> String {
    format!(
        "TEST_ENV_UNAVAILABLE: {message}\n\
SW_TEST_EXIT_CODE=-1\n\
SW_TEST_ENV_UNAVAILABLE=1\n\
SW_TEST_SCOPE_AUTHORITY=untrusted\n\
SW_TEST_SCOPE_TRUSTED=0\n\
SW_TEST_CAN_COMPLETE=0\n\
SW_TEST_COMMAND={run_cmd} {run_args:?}\n\
SW_TEST_TIMED_OUT=0\n\
SW_TEST_EARLY_STOPPED=0\n"
    )
}

fn terminate_child_group(child: &mut Child) {
    unsafe {
        if libc::killpg(child.id() as i32, libc::SIGKILL) != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("[RUN_TEST] process group kill failed: {err}");
            }
        }
    }
    if let Err(err) = child.kill() {
        if err.kind() != std::io::ErrorKind::InvalidInput {
            eprintln!("[RUN_TEST] child kill failed: {err}");
        }
    }
    if let Err(err) = child.wait() {
        eprintln!("[RUN_TEST] child wait failed: {err}");
    }
}

fn run_command_with_limits(
    mut command: Command,
    lang: &str,
    run_cmd: &str,
    run_args: &[String],
    timeout: Option<Duration>,
    stop_on_failure: bool,
    unscoped_probe: bool,
) -> String {
    if timeout.is_none() && !stop_on_failure {
        let start = Instant::now();
        return match command.output() {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                let combined = format!("{}\n{}", stdout, stderr);
                let exit_code = out.status.code().unwrap_or(-1);
                format_test_command_output(
                    lang,
                    run_cmd,
                    run_args,
                    &combined,
                    exit_code,
                    false,
                    false,
                    unscoped_probe,
                    start.elapsed().as_millis(),
                )
            }
            Err(e) => format_test_runner_unavailable(lang, &e, run_cmd, run_args),
        };
    }

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.process_group(0);
    let start = Instant::now();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return format_test_runner_unavailable(lang, &e, run_cmd, run_args);
        }
    };

    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send((false, line)).is_err() {
                    eprintln!("[RUN_TEST] stdout receiver closed while reading command output");
                    break;
                }
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send((true, line)).is_err() {
                    eprintln!("[RUN_TEST] stderr receiver closed while reading command output");
                    break;
                }
            }
        }));
    }
    drop(tx);

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut timed_out = false;
    let mut early_stopped = false;
    let mut failure_seen_at: Option<Instant> = None;
    let mut lines_after_failure = 0usize;
    let mut exit_code = -1;
    let failure_context = std::env::var("SW_TEST_FAILURE_CONTEXT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(5));

    loop {
        while let Ok((is_stderr, line)) = rx.try_recv() {
            if failure_seen_at.is_some() {
                lines_after_failure += 1;
            } else if stop_on_failure && test_failure_stream_signal(&line) {
                failure_seen_at = Some(Instant::now());
            }
            if is_stderr {
                stderr.push_str(&line);
                stderr.push('\n');
            } else {
                stdout.push_str(&line);
                stdout.push('\n');
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }

        if timeout.is_some_and(|limit| start.elapsed() >= limit) {
            timed_out = true;
            terminate_child_group(&mut child);
            break;
        }

        if let Some(seen_at) = failure_seen_at {
            if seen_at.elapsed() >= failure_context || lines_after_failure >= 80 {
                early_stopped = true;
                terminate_child_group(&mut child);
                break;
            }
        }

        std::thread::sleep(Duration::from_millis(50));
    }

    while let Ok((is_stderr, line)) = rx.try_recv() {
        if is_stderr {
            stderr.push_str(&line);
            stderr.push('\n');
        } else {
            stdout.push_str(&line);
            stdout.push('\n');
        }
    }
    for reader in readers {
        if reader.join().is_err() {
            eprintln!("[RUN_TEST] output reader thread panicked");
        }
    }

    let combined = format!("{}\n{}", stdout, stderr);
    format_test_command_output(
        lang,
        run_cmd,
        run_args,
        &combined,
        exit_code,
        timed_out,
        early_stopped,
        unscoped_probe,
        start.elapsed().as_millis(),
    )
}

fn run_test_with_args(args: &Value, workdir: &str) -> String {
    if std::env::var("SW_TEST_PREFLIGHT_UNAVAILABLE")
        .ok()
        .as_deref()
        == Some("1")
    {
        return "TEST_ENV_UNAVAILABLE: test runner preflight failed\nSW_TEST_EXIT_CODE=-1\nSW_TEST_ENV_UNAVAILABLE=1\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\n".into();
    }

    // Reject unrecognized 'command' argument — fail fast rather than silently ignoring
    if args.get("command").is_some() {
        return "ERROR: run_test does not accept a 'command' argument.\n\
                Use run_test({\"path\": \"tests/foo.py\"}) to run specific tests.\n\
                Available args: path, test_file, file, label, args."
            .into();
    }

    let test_path = args.get("path").and_then(|p| p.as_str());
    let explicit_test_file = args.get("test_file").and_then(|p| p.as_str());
    let file_alias = args.get("file").and_then(|p| p.as_str());
    let test_file = explicit_test_file.or(file_alias);
    if explicit_test_file.is_none() {
        if let Some(path) = file_alias {
            if let Err(message) = validate_existing_repo_file(path, workdir) {
                return format!(
                    "ERROR: run_test 'file' must name an existing repository file. {message}\nSW_TEST_EXIT_CODE=-1\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\n"
                );
            }
        }
    }
    let test_label = args
        .get("label")
        .and_then(|p| p.as_str())
        .filter(|label| !label.trim().is_empty());
    let env_test_label = std::env::var("SW_TEST_LABEL")
        .ok()
        .filter(|label| !label.trim().is_empty());
    let has_label_scope = test_label.is_some() || env_test_label.is_some();
    let unscoped = test_path.is_none() && test_file.is_none() && !has_label_scope;
    let unscoped_probe = env_flag("SW_TEST_UNSCOPED_PROBE");

    if std::env::var("SW_EVAL_IMAGE").ok().as_deref() == Some("1") && unscoped {
        if !unscoped_probe {
            return "ERROR: unscoped eval-image run_test is disabled. Provide a validated scoped path/test_file or let the harness run its single bounded discovery probe.\nSW_TEST_EXIT_CODE=-1\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\nSW_TEST_UNSCOPED_BLOCKED=1\n".into();
        }
        match UNSCOPED_TEST_PROBE_USED.lock() {
            Ok(mut used) => {
                if *used {
                    return "ERROR: unscoped eval-image discovery probe was already used; refusing repeated full-suite probe.\nSW_TEST_EXIT_CODE=-1\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\nSW_TEST_UNSCOPED_BLOCKED=1\n".into();
                }
                *used = true;
            }
            Err(_) => {
                return "ERROR: could not acquire unscoped probe guard.\nSW_TEST_EXIT_CODE=-1\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY=untrusted\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\nSW_TEST_UNSCOPED_BLOCKED=1\n".into();
            }
        }
    }

    let extra_args: Vec<String> = args
        .get("args")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let lang = detect_language(workdir);
    let eval_test_cmd = std::env::var("SW_TEST_CMD").ok();
    let plan_scope_args = plan_scope_args(
        test_path,
        test_file,
        test_label.or(env_test_label.as_deref()),
        &extra_args,
    );
    let plan_script = match solver_test_plan::load_from_env() {
        Ok(Some(plan)) => Some(solver_test_plan::shell_script_for_scope(
            &plan,
            &solver_test_plan::adapt_scope_args(&plan, &plan_scope_args),
        )),
        Ok(None) => None,
        Err(err) => {
            return format_test_setup_unavailable(
                &format!("solver test plan unavailable: {err}"),
                "solver-test-plan",
                &[],
            );
        }
    };

    let (cmd, cmd_args, command_env) = if let Some(script) = plan_script {
        (
            "/bin/bash".to_string(),
            vec!["-lc".to_string(), script],
            Vec::new(),
        )
    } else {
        match lang {
            "go" => {
                let mut a = vec!["test".to_string(), "-v".to_string(), "-count=1".to_string()];
                if let Some(p) = test_path {
                    a.push(format!("./{}/...", p));
                } else if let Some(f) = test_file {
                    a.push(format!(
                        "./{}",
                        std::path::Path::new(f)
                            .parent()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|| ".".into())
                    ));
                } else {
                    a.push("./...".to_string());
                }
                a.extend(extra_args);
                ("go".to_string(), a, Vec::new())
            }
            "rust" => {
                let mut a = vec!["test".to_string()];
                if let Some(p) = test_path {
                    a.push("--".to_string());
                    a.push(p.to_string());
                }
                a.extend(extra_args);
                ("cargo".to_string(), a, Vec::new())
            }
            "typescript" | "javascript" => {
                let (runner, mut runner_args) = detect_js_test_runner(workdir);
                if let Some(p) = test_path {
                    runner_args.push(p.to_string());
                } else if let Some(f) = test_file {
                    runner_args.push(f.to_string());
                }
                runner_args.extend(extra_args);
                (runner, runner_args, Vec::new())
            }
            _ => {
                // Python: detect Django vs pytest
                let p = Path::new(workdir);
                let is_django = p.join("manage.py").exists()
                    || p.join("django").is_dir()
                    || p.join("setup.cfg").exists()
                        && std::fs::read_to_string(p.join("setup.cfg"))
                            .map(|c| c.contains("[metadata]") && c.contains("django"))
                            .unwrap_or(false);
                let has_pytest_support = p.join("pytest.ini").exists()
                    || p.join("conftest.py").exists()
                    || p.join("pyproject.toml").exists()
                        && std::fs::read_to_string(p.join("pyproject.toml"))
                            .map(|c| {
                                c.contains("[tool.pytest.ini_options]") || c.contains("pytest")
                            })
                            .unwrap_or(false)
                    || p.join("tox.ini").exists()
                        && std::fs::read_to_string(p.join("tox.ini"))
                            .map(|c| c.contains("[pytest]"))
                            .unwrap_or(false);

                if let Some(test_cmd) = eval_test_cmd.as_ref() {
                    let mut parts = split_shell_words(test_cmd);
                    let command_env = extract_leading_env_assignments(&mut parts);
                    if parts.is_empty() {
                        parts = vec!["python3".into(), "-m".into(), "pytest".into()];
                    }
                    let push_unique = |parts: &mut Vec<String>, value: String| {
                        if !value.is_empty() && !parts.iter().any(|part| part == &value) {
                            parts.push(value);
                        }
                    };
                    if is_django && !has_pytest_support && p.join("tests/runtests.py").exists() {
                        // Keep Django module-style directive handling when the repo runner is used.
                        if let Some(tp) = test_path {
                            push_unique(&mut parts, django_runtests_target(tp));
                        } else if let Some(f) = test_file {
                            push_unique(&mut parts, django_runtests_target(f));
                        } else if let Some(module) = test_label.or(env_test_label.as_deref()) {
                            push_unique(&mut parts, module.to_string());
                        }
                        for arg in &extra_args {
                            push_unique(&mut parts, django_runtests_target(arg));
                        }
                    } else if let Some(tp) = test_path {
                        push_unique(&mut parts, tp.to_string());
                    } else if let Some(f) = test_file {
                        push_unique(&mut parts, f.to_string());
                    } else if let Some(label) = test_label.or(env_test_label.as_deref()) {
                        push_unique(&mut parts, label.to_string());
                    }
                    if !(is_django && !has_pytest_support && p.join("tests/runtests.py").exists()) {
                        parts.extend(extra_args);
                    }
                    (parts[0].clone(), parts[1..].to_vec(), command_env)
                } else if is_django && !has_pytest_support && p.join("tests/runtests.py").exists() {
                    // Django test suite without pytest support: use the repo's own runner.
                    let mut a: Vec<String> =
                        vec!["tests/runtests.py".into(), "--verbosity=1".into()];
                    if let Some(tp) = test_path {
                        a.push(django_runtests_target(tp));
                    } else if let Some(f) = test_file {
                        a.push(django_runtests_target(f));
                    } else if let Some(label) = test_label.or(env_test_label.as_deref()) {
                        a.push(label.to_string());
                    }
                    a.extend(extra_args.iter().map(|arg| django_runtests_target(arg)));
                    ("python3".to_string(), a, Vec::new())
                } else {
                    let mut a: Vec<String> = vec![
                        "-m".into(),
                        "pytest".into(),
                        "-xvs".into(),
                        "--tb=short".into(),
                        "--no-header".into(),
                        "-q".into(),
                    ];
                    if is_django {
                        a.push("-m".into());
                        a.push("django".into());
                    }
                    if let Some(tp) = test_path {
                        a.push(tp.to_string());
                    } else if let Some(f) = test_file {
                        a.push(f.to_string());
                    } else if let Some(label) = test_label.or(env_test_label.as_deref()) {
                        a.push(label.to_string());
                    }
                    a.extend(extra_args);
                    ("python3".to_string(), a, Vec::new())
                }
            }
        }
    };

    // Install deps if needed (JS/TS only, first run)
    if matches!(lang, "typescript" | "javascript") {
        let p = Path::new(workdir);
        if !p.join("node_modules").exists() && p.join("package.json").exists() {
            let pkg_mgr = if p.join("pnpm-lock.yaml").exists() && command_exists("pnpm") {
                "pnpm"
            } else if p.join("yarn.lock").exists() && command_exists("yarn") {
                "yarn"
            } else {
                "npm"
            };
            let install_args = vec!["install".to_string()];
            match Command::new(pkg_mgr)
                .arg("install")
                .current_dir(workdir)
                .output()
            {
                Ok(output) if output.status.success() => {}
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let detail = format!(
                        "dependency install failed ({pkg_mgr} install) status={} stderr={} stdout={}",
                        output.status,
                        stderr.trim(),
                        stdout.trim()
                    );
                    return format_test_setup_unavailable(&detail, pkg_mgr, &install_args);
                }
                Err(err) => {
                    let detail = format!("dependency install failed ({pkg_mgr} install): {err}");
                    return format_test_setup_unavailable(&detail, pkg_mgr, &install_args);
                }
            }
        }
    }

    let cmd_name = Path::new(&cmd)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(cmd.as_str());
    let python_command = matches!(cmd_name, "python" | "python3" | "pytest" | "py.test");
    let use_eval_conda = std::env::var("SW_EVAL_IMAGE").ok().as_deref() == Some("1")
        && lang == "python"
        && command_exists("conda");
    let conda_env = std::env::var("SW_TEST_CONDA_ENV").unwrap_or_else(|_| "testbed".to_string());

    let (run_cmd, run_args) = if use_eval_conda {
        let mut wrapped = vec![
            "run".to_string(),
            "-n".to_string(),
            conda_env,
            "--no-capture-output".to_string(),
            cmd.clone(),
        ];
        wrapped.extend(cmd_args.clone());
        ("conda".to_string(), wrapped)
    } else {
        (cmd.clone(), cmd_args.clone())
    };

    let mut command = Command::new(&run_cmd);
    command
        .args(&run_args)
        .current_dir(workdir)
        .env("PYTHONDONTWRITEBYTECODE", "1");
    for (name, value) in &command_env {
        command.env(name, value);
    }

    if lang == "python" || python_command {
        let pythonpath = match std::env::var("PYTHONPATH") {
            Ok(existing) if !existing.is_empty() => format!("{}:{}", workdir, existing),
            _ => workdir.to_string(),
        };
        command.env("PYTHONPATH", pythonpath);
    }

    let timeout = std::env::var("SW_TEST_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .or_else(|| unscoped_probe.then_some(Duration::from_secs(300)));
    let stop_on_failure = env_flag("SW_TEST_STOP_ON_FAILURE") || unscoped_probe;
    run_command_with_limits(
        command,
        lang,
        &run_cmd,
        &run_args,
        timeout,
        stop_on_failure,
        unscoped_probe,
    )
}

pub(crate) fn run_test_direct_with_args(args: &Value, workdir: &str) -> String {
    run_test_with_args(args, workdir)
}

fn run_test_with_sandbox(args: &Value, workdir: &str) -> String {
    let mut slot = match VALIDATION_SANDBOX.lock() {
        Ok(slot) => slot,
        Err(_) => {
            return format_test_setup_unavailable(
                "validation sandbox lock poisoned",
                "validation-sandbox",
                &[],
            );
        }
    };
    let Some(sandbox) = slot.as_mut() else {
        return run_test_with_args(args, workdir);
    };
    match sandbox.validate(args) {
        Ok(output) => output,
        Err(err) => format_test_setup_unavailable(&err, "validation-sandbox", &[]),
    }
}

fn plan_scope_args(
    test_path: Option<&str>,
    test_file: Option<&str>,
    test_label: Option<&str>,
    extra_args: &[String],
) -> Vec<String> {
    let mut result = Vec::new();
    if let Some(path) = test_path.or(test_file).or(test_label) {
        if !path.trim().is_empty() {
            result.push(path.to_string());
        }
    }
    result.extend(
        extra_args
            .iter()
            .filter(|arg| !arg.trim().is_empty())
            .cloned(),
    );
    result
}

fn split_shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some('\''), c) => current.push(c),
            (Some('"'), '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => quote = Some(ch),
            (None, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            (None, c) => current.push(c),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn extract_leading_env_assignments(parts: &mut Vec<String>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if parts.first().is_some_and(|part| part == "env") {
        parts.remove(0);
    }
    while parts
        .first()
        .is_some_and(|part| parse_env_assignment(part).is_some())
    {
        let part = parts.remove(0);
        if let Some(pair) = parse_env_assignment(&part) {
            env.push(pair);
        }
    }
    env
}

fn parse_env_assignment(part: &str) -> Option<(String, String)> {
    let (name, value) = part.split_once('=')?;
    if !valid_env_name(name) {
        return None;
    }
    Some((name.to_string(), value.to_string()))
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(ch) if ch == '_' || ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn grep(args: &Value, workdir: &str) -> String {
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'pattern' argument".into(),
    };
    let file = args.get("file").and_then(|f| f.as_str());

    let mut cmd = Command::new("grep");
    // -H forces filename prefix even when a single file is given; without it, Linux grep
    // omits the filename and the FILENAME:LINE:CONTENT parse in localization Step 7 breaks.
    cmd.args(["-rHn", pattern]);
    if let Some(f) = file {
        cmd.arg(f);
    } else {
        cmd.arg(".");
    }
    cmd.current_dir(workdir);

    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.is_empty() {
                "no matches found".into()
            } else {
                stdout.to_string()
            }
        }
        Err(e) => format!("error running grep: {}", e),
    }
}

/// Diff a file against its pre-implementation snapshot.
fn diff(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };

    let Some(snapshot) = stored_snapshot(&SNAPSHOTS, workdir) else {
        return format!("error: no snapshot for repository '{}'", workdir);
    };
    let original = match snapshot.files.get(path) {
        Some(s) => s.clone(),
        None => {
            return format!(
                "error: no snapshot for '{}' — was the file created new?",
                path
            );
        }
    };
    let current = match std::fs::read(Path::new(workdir).join(path)) {
        Ok(c) => c,
        Err(e) => return format!("error reading current '{}': {}", path, e),
    };

    if original == current {
        return "no changes".into();
    }

    // Line-by-line diff
    let original = String::from_utf8_lossy(&original);
    let current = String::from_utf8_lossy(&current);
    let orig_lines: Vec<&str> = original.lines().collect();
    let curr_lines: Vec<&str> = current.lines().collect();
    let mut output = String::new();
    let max_lines = orig_lines.len().max(curr_lines.len());

    for i in 0..max_lines {
        let orig = orig_lines.get(i).copied().unwrap_or("");
        let curr = curr_lines.get(i).copied().unwrap_or("");
        if orig != curr {
            if !orig.is_empty() {
                output.push_str(&format!("- L{}: {}\n", i + 1, orig));
            }
            if !curr.is_empty() {
                output.push_str(&format!("+ L{}: {}\n", i + 1, curr));
            }
        }
    }

    if output.is_empty() {
        "no changes".into()
    } else {
        let changed_lines = output.lines().count() / 2;
        format!("{} line(s) changed:\n{}", changed_lines, output)
    }
}

/// Edit a line in a file by content matching. Finds `old` text in the file
/// and replaces it with `new`. Line number is optional (for disambiguation).
/// This is the key tool for small models — no need to count line numbers accurately.
fn edit_line(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: edit_line requires a 'path' argument. Choose an existing repository-relative file path from read_file/find_files/list_directory output, then provide exact 'old' text and replacement 'new' text.".into(),
    };

    // Edit locus gate: block edits on files with 3+ consecutive failures until read_file
    if let Ok(blocked) = EDIT_BLOCKED.lock() {
        if blocked.contains(path) {
            return format!(
                "EDIT_BLOCKED: You must call read_file on '{}' before editing it again.\n\
                 Use read_file with start_line/end_line to see the current content.",
                path
            );
        }
    }
    let old = args.get("old").and_then(|o| o.as_str());
    let new_content = match args.get("new").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return "error: missing 'new' argument (replacement content)".into(),
    };
    let hint_line = args
        .get("line")
        .and_then(|l| l.as_u64())
        .map(|l| l as usize);

    // Insert mode: no 'old' but 'line' provided → insert after that line
    if old.is_none() {
        if let Some(after) = hint_line {
            let full_path = match validate_existing_repo_file(path, workdir) {
                Ok(path) => path,
                Err(msg) => return msg,
            };
            let content = match std::fs::read_to_string(&full_path) {
                Ok(c) => c,
                Err(e) => return format!("error reading '{}': {}", path, e),
            };
            let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
            let idx = after.min(lines.len());
            // Detect indent from the target line
            let indent: String = if idx > 0 {
                lines[idx - 1]
                    .chars()
                    .take_while(|c| c.is_whitespace())
                    .collect()
            } else {
                String::new()
            };
            let new_trimmed = new_content.trim_start();
            lines.insert(idx, format!("{}{}", indent, new_trimmed));
            let new_file = lines.join("\n") + "\n";
            return match std::fs::write(&full_path, &new_file) {
                Ok(()) => format!("Inserted after L{}: '{}'", after, new_content.trim()),
                Err(e) => format!("error writing '{}': {}", path, e),
            };
        }
        return "error: missing 'old' argument. Provide 'old' (content to find) or 'line' (insert after line N) with 'new'.".into();
    }
    let old = old.unwrap();

    let full_path = match validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => return msg,
    };
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => return format!("error reading '{}': {}", path, e),
    };

    let lines: Vec<&str> = content.lines().collect();
    // Unescape JSON artifacts, strip whitespace and trailing newlines
    let old_unescaped = old
        .replace("\\\"", "\"")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\\", "\\");

    // If model sent multi-line old, delegate to edit_block logic
    let old_line_count = old_unescaped.trim().lines().count();
    if old_line_count > 1 {
        // Redirect to edit_block which handles multi-line matching properly
        let block_args = serde_json::json!({
            "path": path,
            "old": old,
            "new": new_content,
        });
        return edit_block(&block_args, workdir);
    }

    let old_trimmed = old_unescaped.trim();

    // Find all matching lines (trimmed equality)
    let mut matches: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim() == old_trimmed)
        .map(|(i, _)| i)
        .collect();

    let mut fuzzy_matched = false;
    let old_normalized = normalize_edit_match_line(old_trimmed);
    if matches.is_empty() && old_normalized.len() >= 8 {
        matches = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| normalize_edit_match_line(line.trim()) == old_normalized)
            .map(|(i, _)| i)
            .collect();
    }

    // Fallback: substring match if exact trimmed match fails
    if matches.is_empty() {
        matches = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains(old_trimmed))
            .map(|(i, _)| i)
            .collect();
    }

    if matches.is_empty() {
        if let Some(idx) = best_fuzzy_line_match(&lines, old_trimmed, hint_line) {
            matches = vec![idx];
            fuzzy_matched = true;
        }
    }

    if matches.is_empty() {
        // Show actual file content near where the model might have intended.
        // Use grep-like search for keywords from the old content, or show the
        // region around line hint if provided.
        let mut context_hint = String::new();

        if let Some(hint) = hint_line {
            // Model gave a line number — show what's actually there
            let start = hint.saturating_sub(3);
            let end = (hint + 3).min(lines.len());
            context_hint.push_str(&format!("\nActual content around line {}:\n", hint));
            for i in start..end {
                context_hint.push_str(&format!("  L{}: {}\n", i + 1, lines[i]));
            }
        } else {
            // Find lines that share significant content (not empty/trivial)
            let keywords: Vec<&str> = old_trimmed
                .split_whitespace()
                .filter(|w| {
                    w.len() > 3
                        && ![
                            "self", "def", "return", "class", "import", "from", "None", "True",
                            "False",
                        ]
                        .contains(w)
                })
                .take(3)
                .collect();
            if !keywords.is_empty() {
                let keyword = keywords[0];
                let nearby: Vec<String> = lines
                    .iter()
                    .enumerate()
                    .filter(|(_, line)| line.contains(keyword) && line.trim().len() > 5)
                    .take(3)
                    .map(|(i, line)| format!("  L{}: {}", i + 1, line.trim()))
                    .collect();
                if !nearby.is_empty() {
                    context_hint.push_str(&format!(
                        "\nLines containing '{}':\n{}",
                        keyword,
                        nearby.join("\n")
                    ));
                }
            }
        }

        if context_hint.is_empty() {
            context_hint = "\nUse read_file with start_line/end_line to see the actual content before editing.".to_string();
        }

        // Track consecutive edit failures for locus gate
        if let Ok(mut counts) = EDIT_FAIL_COUNT.lock() {
            let count = counts.entry(path.to_string()).or_insert(0);
            *count += 1;
            if *count >= 3 {
                if let Ok(mut blocked) = EDIT_BLOCKED.lock() {
                    blocked.insert(path.to_string());
                }
                return format!(
                    "error: '{}' not found in {}.{}\n\n\
                     [LOCUS RESET] {} consecutive edit failures on this file.\n\
                     Your previous edits changed the file and your anchor text no longer matches.\n\
                     EDIT_BLOCKED: You must call read_file on '{}' before editing it again.",
                    old_trimmed, path, context_hint, count, path
                );
            }
        }

        return format!(
            "error: '{}' not found in {}.{}",
            old_trimmed, path, context_hint
        );
    }

    // Pick the right match
    let target_idx = if matches.len() == 1 {
        matches[0]
    } else if let Some(hint) = hint_line {
        // Use line hint to disambiguate
        *matches
            .iter()
            .min_by_key(|&&idx| (idx as isize - hint as isize).unsigned_abs())
            .unwrap()
    } else {
        // Multiple matches, no line hint — edit ALL occurrences
        let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        let new_trimmed = new_content.trim_start();
        let mut changed = Vec::new();
        for &idx in &matches {
            let indent: String = lines[idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            new_lines[idx] = format!("{}{}", indent, new_trimmed);
            changed.push(format!("L{}", idx + 1));
        }
        let new_file = new_lines.join("\n") + "\n";
        return match std::fs::write(&full_path, &new_file) {
            Ok(()) => {
                if let Ok(mut counts) = EDIT_FAIL_COUNT.lock() {
                    counts.remove(path);
                }
                format!(
                    "{} changed ({}): '{}' -> '{}'",
                    changed.len(),
                    changed.join(", "),
                    old_trimmed,
                    new_content.trim()
                )
            }
            Err(e) => format!("error writing '{}': {}", path, e),
        };
    };

    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();

    // Preserve original indentation: extract leading whitespace from the old line,
    // strip leading whitespace from the replacement, re-indent with the original.
    let original_line = lines[target_idx];
    let indent: String = original_line
        .chars()
        .take_while(|c| c.is_whitespace())
        .collect();
    let new_trimmed = new_content.trim_start();
    new_lines[target_idx] = format!("{}{}", indent, new_trimmed);

    let new_file = new_lines.join("\n") + "\n";

    match std::fs::write(&full_path, &new_file) {
        Ok(()) => {
            // Reset edit failure tracking on success
            if let Ok(mut counts) = EDIT_FAIL_COUNT.lock() {
                counts.remove(path);
            }
            let method = if fuzzy_matched { " fuzzy" } else { "" };
            format!(
                "L{}{} changed: '{}' -> '{}'",
                target_idx + 1,
                method,
                old_trimmed,
                new_content.trim()
            )
        }
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Replace a multi-line block in a file by content matching.
/// Finds `old` (multi-line string) in the file and replaces with `new`.
/// Handles indentation: matches by normalized whitespace, preserves original indent level.
fn edit_block(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };
    let new_content = args
        .get("new")
        .or_else(|| args.get("new_content"))
        .and_then(|n| n.as_str())
        .unwrap_or("");

    // Fallback: if 'old' is missing but start_line/end_line provided, use line-number replacement
    let old = match args.get("old").and_then(|o| o.as_str()) {
        Some(o) => o.to_string(),
        None => {
            let start = args.get("start_line").and_then(|s| s.as_u64());
            let end = args.get("end_line").and_then(|s| s.as_u64());
            if let (Some(start), Some(end)) = (start, end) {
                let full_path = match validate_existing_repo_file(path, workdir) {
                    Ok(path) => path,
                    Err(msg) => return msg,
                };
                let content = match std::fs::read_to_string(&full_path) {
                    Ok(c) => c,
                    Err(e) => return format!("error reading '{}': {}", path, e),
                };
                let lines: Vec<&str> = content.lines().collect();
                let s = (start as usize).saturating_sub(1).min(lines.len());
                let e = (end as usize).min(lines.len());
                if s >= e {
                    return "error: start_line >= end_line".into();
                }
                let new_lines: Vec<&str> = new_content.lines().collect();
                let mut result = lines[..s].to_vec();
                result.extend(new_lines);
                result.extend(&lines[e..]);
                if let Err(err) = std::fs::write(&full_path, result.join("\n") + "\n") {
                    return format!("error writing '{}': {}", path, err);
                }
                return format!("replaced lines {}-{} in {}", start, end, path);
            }
            return "error: missing 'old' argument (block content to find). Use 'old'/'new' or 'start_line'/'end_line'/'new_content'.".into();
        }
    };
    let old = old.as_str();

    let full_path = match validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => return msg,
    };
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => return format!("error reading '{}': {}", path, e),
    };

    // Unescape JSON artifacts from native tool calling (models send \" for ")
    let old_unescaped = old
        .replace("\\\"", "\"")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\\", "\\");

    // Normalize the old block for matching: trim each line, collapse whitespace
    let mut old_lines: Vec<&str> = old_unescaped
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if old_lines.is_empty() {
        return "error: 'old' block is empty".into();
    }

    let file_lines: Vec<&str> = content.lines().collect();

    // Sliding window search: find where old_lines match in file_lines (by trimmed content)
    // First try exact trim match, then fuzzy (substring) match
    let mut match_start = None;
    for i in 0..file_lines.len() {
        if file_lines.len() - i < old_lines.len() {
            break;
        }
        let mut matches = true;
        for (j, old_line) in old_lines.iter().enumerate() {
            if file_lines[i + j].trim() != *old_line
                && normalize_edit_match_line(file_lines[i + j])
                    != normalize_edit_match_line(old_line)
            {
                matches = false;
                break;
            }
        }
        if matches {
            match_start = Some(i);
            break;
        }
    }

    // Fuzzy fallback: if exact match failed, try matching first+last lines
    // and check that the block length is close
    if match_start.is_none() && old_lines.len() >= 2 {
        let first = old_lines[0];
        let last = old_lines[old_lines.len() - 1];
        let first_norm = normalize_edit_match_line(first);
        let last_norm = normalize_edit_match_line(last);
        for i in 0..file_lines.len() {
            if file_lines.len() - i < old_lines.len() {
                break;
            }
            if file_lines[i].trim() == first
                || normalize_edit_match_line(file_lines[i]) == first_norm
            {
                // Check if last line matches within a reasonable window
                let search_end = (i + old_lines.len() + 5).min(file_lines.len());
                for end in i + 1..search_end {
                    if file_lines[end].trim() == last
                        || normalize_edit_match_line(file_lines[end]) == last_norm
                    {
                        let span = end - i + 1;
                        // Accept if span is within 3 lines of expected
                        if span.abs_diff(old_lines.len()) <= 3 {
                            match_start = Some(i);
                            // Use actual span for replacement range
                            old_lines = file_lines[i..=end].iter().map(|l| l.trim()).collect();
                            break;
                        }
                    }
                }
                if match_start.is_some() {
                    break;
                }
            }
        }
    }

    let start = match match_start {
        Some(s) => s,
        None => {
            let search_preview = old_lines
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(" | ");
            // Find where the first line of the block occurs to show actual context
            let first_line = old_lines[0];
            let mut context_hint = String::new();
            for (i, fl) in file_lines.iter().enumerate() {
                if fl.trim().contains(first_line) || first_line.contains(fl.trim()) {
                    if fl.trim().len() > 5 {
                        let start = i.saturating_sub(2);
                        let end = (i + old_lines.len() + 2).min(file_lines.len());
                        context_hint.push_str(&format!("\nActual content near L{}:\n", i + 1));
                        for j in start..end {
                            context_hint.push_str(&format!("  L{}: {}\n", j + 1, file_lines[j]));
                        }
                        break;
                    }
                }
            }
            return format!(
                "error: block not found in {}. Looking for: '{}'.{}",
                path, search_preview, context_hint
            );
        }
    };

    // Detect the indentation level from the first matched line
    let indent: String = file_lines[start]
        .chars()
        .take_while(|c| c.is_whitespace())
        .collect();

    // Build the replacement: apply the original indentation to each new line
    let new_lines: Vec<String> = new_content
        .lines()
        .enumerate()
        .map(|(i, line)| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() {
                String::new()
            } else if i == 0 {
                // First line gets the original indent
                format!("{}{}", indent, trimmed)
            } else {
                // Subsequent lines: detect relative indent from new_content and add base indent
                let new_base_indent = new_content
                    .lines()
                    .next()
                    .map(|first| first.len() - first.trim_start().len())
                    .unwrap_or(0);
                let this_indent = line.len() - trimmed.len();
                let relative = this_indent.saturating_sub(new_base_indent);
                let extra: String = " ".repeat(relative);
                format!("{}{}{}", indent, extra, trimmed)
            }
        })
        .collect();

    // Replace the matched range with the new lines
    let mut result_lines: Vec<String> = Vec::new();
    result_lines.extend(file_lines[..start].iter().map(|l| l.to_string()));
    result_lines.extend(new_lines);
    result_lines.extend(
        file_lines[start + old_lines.len()..]
            .iter()
            .map(|l| l.to_string()),
    );

    let new_file = result_lines.join("\n") + "\n";
    let old_count = old_lines.len();
    let new_count = new_content.lines().count();

    match std::fs::write(&full_path, &new_file) {
        Ok(()) => {
            let mut msg = format!(
                "replaced {} lines with {} lines at L{} in {}",
                old_count,
                new_count,
                start + 1,
                path
            );
            // Include diff for TUI rendering
            for line in old_lines.iter().take(5) {
                msg.push_str(&format!("\n- {}", line));
            }
            if old_lines.len() > 5 {
                msg.push_str("\n- ...");
            }
            for line in new_content.lines().take(5) {
                msg.push_str(&format!("\n+ {}", line.trim()));
            }
            if new_count > 5 {
                msg.push_str("\n+ ...");
            }
            msg
        }
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Apply a unified diff patch string. Handles SWE-agent/Devin-style patch format.
/// Accepts `*** Begin Patch` format or simple `-/+` line format.
fn apply_patch(args: &Value, workdir: &str) -> String {
    let patch = match args.get("patch").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'patch' argument".into(),
    };

    // Parse the patch: look for file references and -/+ lines
    let mut current_file: Option<String> = None;
    let mut removals: Vec<String> = Vec::new();
    let mut additions: Vec<String> = Vec::new();
    let mut applied = 0;
    let mut errors = Vec::new();

    for line in patch.lines() {
        let trimmed = line.trim();

        // Detect file path
        if trimmed.starts_with("*** Add File:") {
            errors.push(
                "BLOCKED: apply_patch cannot create files. Use create_file with an existing repository directory when a new file is required."
                    .to_string(),
            );
            current_file = None;
            removals.clear();
            additions.clear();
        } else if trimmed.starts_with("*** Update File:") || trimmed.starts_with("--- a/") {
            // Flush previous file's changes
            if let Some(ref file) = current_file {
                match apply_diff_to_file(file, &removals, &additions, workdir) {
                    Ok(n) => applied += n,
                    Err(e) => errors.push(e),
                }
                removals.clear();
                additions.clear();
            }
            // Extract filename
            let name = trimmed
                .trim_start_matches("*** Update File:")
                .trim_start_matches("--- a/")
                .trim();
            current_file = Some(name.to_string());
        } else if trimmed.starts_with('-') && !trimmed.starts_with("---") {
            removals.push(trimmed[1..].trim().to_string());
        } else if trimmed.starts_with('+') && !trimmed.starts_with("+++") {
            additions.push(trimmed[1..].trim().to_string());
        }
    }

    // Flush last file
    if let Some(ref file) = current_file {
        match apply_diff_to_file(file, &removals, &additions, workdir) {
            Ok(n) => applied += n,
            Err(e) => errors.push(e),
        }
    }

    // Raw +/- patches are ambiguous. Never guess which repository file to mutate.
    if current_file.is_none() && (!removals.is_empty() || !additions.is_empty()) {
        errors.push(
            "ambiguous patch: include an exact '*** Update File:' or '--- a/' path".to_string(),
        );
    }

    if applied > 0 {
        let msg = format!("{} change(s) applied", applied);
        if !errors.is_empty() {
            format!("{} (warnings: {})", msg, errors.join("; "))
        } else {
            msg
        }
    } else if !errors.is_empty() {
        format!("patch failed: {}", errors.join("; "))
    } else {
        "patch had no effect — no matching lines found".into()
    }
}

/// Apply a set of removals/additions to a file by content matching.
fn apply_diff_to_file(
    filename: &str,
    removals: &[String],
    additions: &[String],
    workdir: &str,
) -> Result<usize, String> {
    let path = validate_existing_repo_file(filename, workdir)?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("can't read {}: {}", filename, e))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut applied = 0;

    // For each removal, find it and replace with the corresponding addition
    for (i, removal) in removals.iter().enumerate() {
        let removal_trimmed = removal.trim();
        if removal_trimmed.is_empty() {
            continue;
        }

        if let Some(idx) = lines.iter().position(|l| l.trim() == removal_trimmed) {
            if i < additions.len() {
                // Preserve indentation
                let indent: String = lines[idx]
                    .chars()
                    .take_while(|c| c.is_whitespace())
                    .collect();
                let new_trimmed = additions[i].trim();
                lines[idx] = format!("{}{}", indent, new_trimmed);
            } else {
                lines.remove(idx);
            }
            applied += 1;
        }
    }

    // Handle additions that don't have corresponding removals (pure insertions)
    // Skip for now — replacement-only is the common case

    if applied > 0 {
        let new_content = lines.join("\n") + "\n";
        std::fs::write(&path, new_content)
            .map_err(|e| format!("can't write {}: {}", filename, e))?;
    }

    Ok(applied)
}

/// Apply multiple patches to a file by content matching.
/// Each patch has `old` (content to find) and `new` (replacement). `line` is optional hint.
fn patch_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };
    let patches = match args.get("patches").and_then(|p| p.as_array()) {
        Some(p) => p,
        None => return "error: missing 'patches' argument (array of {old, new} objects)".into(),
    };

    let full_path = match validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => return msg,
    };
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => return format!("error reading '{}': {}", path, e),
    };

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut applied = 0;
    let mut errors = Vec::new();
    let mut changes: Vec<(String, String)> = Vec::new();

    for patch in patches {
        let old = match patch.get("old").and_then(|o| o.as_str()) {
            Some(o) => o,
            None => {
                errors.push("patch missing 'old' field".to_string());
                continue;
            }
        };
        let new_content = match patch.get("new").and_then(|n| n.as_str()) {
            Some(n) => n,
            None => {
                errors.push("patch missing 'new' field".to_string());
                continue;
            }
        };

        let old_unescaped = old
            .replace("\\\"", "\"")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\\\", "\\");
        let old_trimmed = old_unescaped.trim();
        let old_line_count = old_trimmed.lines().count();

        if old_line_count > 1 {
            // Multi-line old: sliding window match (same as edit_block)
            let old_parts: Vec<&str> = old_trimmed
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
            let mut found_start: Option<usize> = None;
            for i in 0..lines
                .len()
                .saturating_sub(old_parts.len().saturating_sub(1))
            {
                let mut ok = true;
                for (j, pat) in old_parts.iter().enumerate() {
                    if i + j >= lines.len() || lines[i + j].trim() != *pat {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    found_start = Some(i);
                    break;
                }
            }
            match found_start {
                Some(idx) => {
                    let indent: String = lines[idx]
                        .chars()
                        .take_while(|c| c.is_whitespace())
                        .collect();
                    let new_lines: Vec<String> = new_content
                        .lines()
                        .map(|l| {
                            let t = l.trim_start();
                            if t.is_empty() {
                                String::new()
                            } else {
                                format!("{}{}", indent, t)
                            }
                        })
                        .collect();
                    let old_preview = old_parts[0].to_string();
                    lines.splice(idx..idx + old_parts.len(), new_lines);
                    changes.push((
                        old_preview,
                        new_content.lines().next().unwrap_or("").to_string(),
                    ));
                    applied += 1;
                }
                None => {
                    errors.push(format!("'{}' not found", old_parts[0]));
                }
            }
            continue;
        }

        let found = lines.iter().position(|l| l.trim() == old_trimmed);

        // Substring fallback
        let found = found.or_else(|| lines.iter().position(|l| l.contains(old_trimmed)));

        match found {
            Some(idx) => {
                let original = lines[idx].clone();
                let indent: String = lines[idx]
                    .chars()
                    .take_while(|c| c.is_whitespace())
                    .collect();
                let new_trimmed = new_content.trim_start();
                lines[idx] = format!("{}{}", indent, new_trimmed);
                changes.push((original, lines[idx].clone()));
                applied += 1;
            }
            None => {
                errors.push(format!("'{}' not found in file", old_trimmed));
            }
        }
    }

    if !errors.is_empty() && applied == 0 {
        return format!("errors applying patches:\n{}", errors.join("\n"));
    }

    let new_file = lines.join("\n") + "\n";
    match std::fs::write(&full_path, &new_file) {
        Ok(()) => {
            let mut msg = format!("{} patch(es) applied to {}", applied, path);
            for (old_line, new_line) in &changes {
                msg.push_str(&format!("\n- {}\n+ {}", old_line.trim(), new_line.trim()));
            }
            if !errors.is_empty() {
                msg.push_str(&format!(" (warnings: {})", errors.join("; ")));
            }
            msg
        }
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Count how many lines changed between snapshot and current file.
/// Returns (lines_changed, total_lines_original).
pub fn diff_stats(path: &str, workdir: &str) -> (usize, usize) {
    let Some(snapshot) = stored_snapshot(&SNAPSHOTS, workdir) else {
        return (0, 0);
    };
    let original = match snapshot.files.get(path) {
        Some(s) => s.clone(),
        None => return (0, 0),
    };

    let original = String::from_utf8_lossy(&original);
    let orig_lines: Vec<&str> = original.lines().collect();

    let current = match std::fs::read(Path::new(workdir).join(path)) {
        Ok(c) => c,
        Err(_) => return (orig_lines.len().max(1), orig_lines.len()),
    };

    let current = String::from_utf8_lossy(&current);

    // Use LCS-based diff to count only actually changed/inserted/deleted lines,
    // not positional shifts from insertions.
    let diff = similar::TextDiff::from_lines(original.as_ref(), current.as_ref());
    let mut changed = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert | similar::ChangeTag::Delete => {
                changed += 1;
            }
            similar::ChangeTag::Equal => {}
        }
    }

    (changed, orig_lines.len())
}

/// Get diff stats for ALL snapshotted files. Returns vec of (filename, changed, total).
pub fn all_diff_stats(workdir: &str) -> Vec<(String, usize, usize)> {
    let files: Vec<String> = stored_snapshot(&SNAPSHOTS, workdir)
        .map(|snapshot| snapshot.files.keys().cloned().collect())
        .unwrap_or_default();

    let mut results: Vec<(String, usize, usize)> = files
        .into_iter()
        .map(|f| {
            let (changed, total) = diff_stats(&f, workdir);
            (f, changed, total)
        })
        .filter(|(_, changed, _)| *changed > 0)
        .collect();

    // Also detect new untracked files (created by write_file, not in snapshot)
    if let Ok(output) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workdir)
        .output()
    {
        let status = String::from_utf8_lossy(&output.stdout);
        for line in status.lines() {
            if line.starts_with("?? ") {
                let path = line[3..].trim_end_matches('/');
                if !results.iter().any(|(f, _, _)| f == path) {
                    // Count lines in new file as "changed"
                    let full = std::path::Path::new(workdir).join(path);
                    let lines = std::fs::read_to_string(&full)
                        .map(|c| c.lines().count())
                        .unwrap_or(1);
                    results.push((path.to_string(), lines, lines));
                }
            }
        }
    }

    results
}

/// Insert a line between two anchor strings in a file.
/// Finds `after` and `before` in the file and inserts `new` between them.
fn insert_between(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };
    let after_anchor = match args.get("after").and_then(|a| a.as_str()) {
        Some(a) => a.trim(),
        None => return "error: missing 'after' argument (line content to insert after)".into(),
    };
    let new_content = match args.get("new").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return "error: missing 'new' argument (content to insert)".into(),
    };
    let before_anchor = args
        .get("before")
        .and_then(|b| b.as_str())
        .map(|s| s.trim());

    let full_path = match validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => return msg,
    };
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => return format!("error reading '{}': {}", path, e),
    };

    let lines: Vec<&str> = content.lines().collect();

    // Find the 'after' anchor line
    let after_idx = lines.iter().position(|l| l.trim().contains(after_anchor));
    let after_idx = match after_idx {
        Some(i) => i,
        None => return format!("error: '{}' not found in {}", after_anchor, path),
    };

    // If 'before' anchor given, verify it exists after the 'after' anchor
    if let Some(before) = before_anchor {
        let before_found = lines[after_idx..].iter().any(|l| l.trim().contains(before));
        if !before_found {
            return format!("error: '{}' not found after '{}'", before, after_anchor);
        }
    }

    // Detect indentation from the after line
    let indent: String = lines[after_idx]
        .chars()
        .take_while(|c| c.is_whitespace())
        .collect();

    // Insert after the anchor line
    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let new_trimmed = new_content.trim();
    new_lines.insert(after_idx + 1, format!("{}{}", indent, new_trimmed));

    let new_file = new_lines.join("\n") + "\n";
    match std::fs::write(&full_path, &new_file) {
        Ok(()) => format!(
            "Inserted '{}' after L{} ('{}') in {}",
            new_trimmed,
            after_idx + 1,
            after_anchor,
            path
        ),
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Inspect a class: show its inheritance tree, file locations, and key attributes.
/// Language-aware: Python uses AST, others fall back to grep.
fn inspect_class(args: &Value, workdir: &str) -> String {
    let class_name = match args
        .get("class")
        .or(args.get("name"))
        .and_then(|c| c.as_str())
    {
        Some(c) => c,
        None => return "error: missing 'class' argument (class name to inspect)".into(),
    };
    let check_attr = args.get("attribute").and_then(|a| a.as_str()).unwrap_or("");

    // Detect language from nearby files
    let has_py = Path::new(workdir).join("setup.py").exists()
        || Path::new(workdir).join("pyproject.toml").exists()
        || std::fs::read_dir(workdir).ok().map_or(false, |e| {
            e.filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().ends_with(".py"))
        });

    if has_py {
        // Python: AST-based class hierarchy walk
        let attr_check = if !check_attr.is_empty() {
            format!(
                "                has_attr = any(isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '{}' for t in s.targets) for s in node.body)",
                check_attr
            )
        } else {
            "                has_attr = True".to_string()
        };
        let attr_label = if !check_attr.is_empty() {
            format!(
                "f' — {}: {{\"yes\" if has_attr else \"MISSING\"}}'",
                check_attr
            )
        } else {
            "''".to_string()
        };

        // Grep-first then AST-parse: much faster on large repos
        let script = format!(
            r#"import ast, os, subprocess
target = '{class_name}'
checked = set()
queue = [target]
results = []
while queue:
    name = queue.pop(0)
    if name in checked: continue
    checked.add(name)
    grep = subprocess.run(['grep', '-rn', f'class {{name}}(', '.'], capture_output=True, text=True)
    if not grep.stdout:
        grep = subprocess.run(['grep', '-rn', f'class {{name}}:', '.'], capture_output=True, text=True)
    if not grep.stdout: continue
    for line in grep.stdout.strip().split('\n')[:2]:
        parts = line.split(':', 2)
        if len(parts) < 3: continue
        path = parts[0]
        if '__pycache__' in path or '/test' in path: continue
        try:
            with open(path) as f: tree = ast.parse(f.read())
        except: continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == name:
{attr_check}
                label = {attr_label}
                results.append(f'  {{name}} @ {{os.path.relpath(path)}}:{{node.lineno}}{{label}}')
                for base in node.bases:
                    bname = base.attr if hasattr(base, 'attr') else base.id if hasattr(base, 'id') else None
                    if bname and bname not in ('object', 'type'): queue.append(bname)
                break
        break
if results:
    print('Class hierarchy for ' + target + ':')
    for r in results: print(r)
else:
    print('Class ' + target + ' not found')
"#,
            class_name = class_name,
            attr_check = attr_check,
            attr_label = attr_label,
        );

        match Command::new("python3")
            .args(["-c", &script])
            .current_dir(workdir)
            .output()
        {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !stdout.is_empty() {
                    stdout.to_string()
                } else if !stderr.is_empty() {
                    format!("error: {}", stderr)
                } else {
                    format!("Class {} not found", class_name)
                }
            }
            Err(e) => format!("error: {}", e),
        }
    } else {
        // Non-Python: grep-based fallback
        let grep_result = Command::new("grep")
            .args([
                "-rn",
                &format!(
                    "class {}|struct {}|impl {}|type {}|interface {}",
                    class_name, class_name, class_name, class_name, class_name
                ),
                ".",
            ])
            .current_dir(workdir)
            .output();
        match grep_result {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.is_empty() {
                    format!("Class {} not found", class_name)
                } else {
                    format!("Definitions of {}:\n{}", class_name, stdout)
                }
            }
            Err(e) => format!("error: {}", e),
        }
    }
}

/// Search for files by name pattern (recursive).
fn find_files(args: &Value, workdir: &str) -> String {
    let pattern = args
        .get("pattern")
        .and_then(|p| p.as_str())
        .unwrap_or("*.py");
    let output = Command::new("find")
        .args([
            ".",
            "-name",
            pattern,
            "-not",
            "-path",
            "*/.git/*",
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/__pycache__/*",
            "-not",
            "-path",
            "*/target/*",
        ])
        .current_dir(workdir)
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.is_empty() {
                "no files found".into()
            } else {
                let mut files: Vec<&str> = stdout.lines().collect();
                files.sort();
                files.join("\n")
            }
        }
        Err(e) => format!("error: {}", e),
    }
}

/// Extract raw file blocks from model output and write them to disk.
/// Models can output `<write_file path="relative/path.py">content</write_file>`
/// as an alternative to the JSON write_file tool call. This avoids JSON escaping
/// overhead that causes self-truncation on large files.
///
/// Returns a vec of (path, bytes_written) for each block extracted.
fn extract_file_blocks_inner(response: &str, workdir: &str) -> (Vec<(String, usize)>, Vec<String>) {
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut search_from = 0;

    while let Some(tag_start) = response[search_from..].find("<write_file path=\"") {
        let abs_start = search_from + tag_start;
        let after_tag = abs_start + "<write_file path=\"".len();

        // Extract path (find closing quote)
        let path_end = match response[after_tag..].find('"') {
            Some(i) => after_tag + i,
            None => break,
        };
        let path = &response[after_tag..path_end];

        // Find the closing `>` of the opening tag
        let content_start = match response[path_end..].find('>') {
            Some(i) => path_end + i + 1,
            None => break,
        };

        // Find closing tag
        let close_tag = "</write_file>";
        let content_end = match response[content_start..].find(close_tag) {
            Some(i) => content_start + i,
            None => {
                // No closing tag — take everything remaining (truncated output)
                response.len()
            }
        };

        let mut content = &response[content_start..content_end];
        // Strip single leading newline (artifact of tag being on its own line)
        if content.starts_with('\n') {
            content = &content[1..];
        }
        // Strip single trailing newline before close tag
        let content = content.trim_end_matches('\n');

        if content.is_empty() || path.is_empty() {
            search_from = content_end + close_tag.len();
            continue;
        }

        // Security: prevent path traversal
        if path.contains("..") || path.starts_with('/') {
            search_from = content_end + close_tag.len();
            continue;
        }

        let full_path = match validate_existing_repo_file(path, workdir) {
            Ok(path) => path,
            Err(msg) => {
                errors.push(msg);
                search_from = content_end + close_tag.len();
                continue;
            }
        };

        let bytes = content.len();
        if std::fs::write(&full_path, content).is_ok() {
            results.push((path.to_string(), bytes));
        }

        search_from = if content_end + close_tag.len() <= response.len() {
            content_end + close_tag.len()
        } else {
            response.len()
        };
    }

    (results, errors)
}

pub fn extract_file_blocks(response: &str, workdir: &str) -> Vec<(String, usize)> {
    extract_file_blocks_inner(response, workdir).0
}

pub fn extract_file_block_errors(response: &str, workdir: &str) -> Vec<String> {
    extract_file_blocks_inner(response, workdir).1
}

/// Restore all snapshotted files to their original content.
pub fn restore_snapshot(workdir: &str) {
    if let Some(snapshot) = stored_snapshot(&SNAPSHOTS, workdir) {
        restore_snapshot_inner(workdir, &snapshot);
    }
}

/// Detect project language from manifest files and file extensions.
/// Returns "python", "go", "typescript", "javascript", "rust", or "unknown".
pub fn detect_language(workdir: &str) -> &'static str {
    let p = Path::new(workdir);
    // Manifest-based detection (most reliable)
    if p.join("Cargo.toml").exists() {
        return "rust";
    }
    if p.join("go.mod").exists() {
        return "go";
    }
    if p.join("tsconfig.json").exists() {
        return "typescript";
    }
    if p.join("pyproject.toml").exists()
        || p.join("setup.py").exists()
        || p.join("setup.cfg").exists()
    {
        return "python";
    }
    if p.join("package.json").exists() {
        // Disambiguate JS vs TS: check for tsconfig or .ts files
        if p.join("tsconfig.json").exists() {
            return "typescript";
        }
        return "javascript";
    }
    // Fallback: scan top-level files for dominant extension
    if let Ok(entries) = std::fs::read_dir(workdir) {
        let mut py = 0u32;
        let mut go = 0u32;
        let mut ts = 0u32;
        let mut js = 0u32;
        let mut rs = 0u32;
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".py") {
                py += 1;
            } else if name.ends_with(".go") {
                go += 1;
            } else if name.ends_with(".ts") || name.ends_with(".tsx") {
                ts += 1;
            } else if name.ends_with(".js") || name.ends_with(".jsx") {
                js += 1;
            } else if name.ends_with(".rs") {
                rs += 1;
            }
        }
        let max = py.max(go).max(ts).max(js).max(rs);
        if max > 0 {
            if py == max {
                return "python";
            }
            if go == max {
                return "go";
            }
            if ts == max {
                return "typescript";
            }
            if js == max {
                return "javascript";
            }
            if rs == max {
                return "rust";
            }
        }
    }
    "unknown"
}

/// Check if a command exists on PATH.
fn command_exists(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Pick the package manager runner, preferring the lockfile match but falling back to npx.
fn pick_js_runner(workdir: &str) -> String {
    let p = Path::new(workdir);
    if p.join("pnpm-lock.yaml").exists() && command_exists("pnpm") {
        "pnpm".into()
    } else if p.join("yarn.lock").exists() && command_exists("yarn") {
        "yarn".into()
    } else if command_exists("npx") {
        "npx".into()
    } else {
        "npm".into()
    }
}

/// Detect the test runner command for a TypeScript/JavaScript project.
/// Checks package.json scripts and lockfiles.
fn detect_js_test_runner(workdir: &str) -> (String, Vec<String>) {
    let p = Path::new(workdir);
    if let Ok(pkg) = std::fs::read_to_string(p.join("package.json")) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&pkg) {
            let scripts = parsed.get("scripts");
            let has_test = scripts
                .and_then(|s| s.get("test"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            // Check for vitest config file (higher priority than package.json script)
            if p.join("vitest.config.ts").exists()
                || p.join("vitest.config.js").exists()
                || p.join("vitest.config.mts").exists()
                || has_test.contains("vitest")
            {
                let runner = pick_js_runner(workdir);
                return (runner, vec!["vitest".into(), "run".into()]);
            }
            if has_test.contains("jest") {
                let runner = pick_js_runner(workdir);
                return (runner, vec!["jest".into(), "--verbose".into()]);
            }
            if has_test.contains("mocha") {
                return ("npx".into(), vec!["mocha".into()]);
            }
            // Generic: run the test script
            if !has_test.is_empty() && has_test != "echo \"Error: no test specified\" && exit 1" {
                let runner = pick_js_runner(workdir);
                return (runner, vec!["test".into()]);
            }
        }
    }
    // Fallback
    ("npx".into(), vec!["vitest".into(), "run".into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{LazyLock, Mutex};

    static SNAPSHOT_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("failed to create temp dir")
    }

    fn restore_test_env(name: &str, previous: Option<String>) {
        unsafe {
            if let Some(value) = previous {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }

    fn write_executable(path: &Path, content: &str) {
        fs::write(path, content).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn django_runtests_target_converts_extra_file_args_to_labels() {
        assert_eq!(
            django_runtests_target("tests/model_fields/test_imagefield.py"),
            "model_fields.test_imagefield"
        );
        assert_eq!(
            django_runtests_target(
                "./tests/forms_tests/tests/test_forms.py::FormsTest::test_clean"
            ),
            "forms_tests.tests.test_forms.FormsTest.test_clean"
        );
        assert_eq!(django_runtests_target("--verbosity=1"), "--verbosity=1");
    }

    #[test]
    fn run_test_converts_django_scope_args_to_labels() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("tests/model_fields")).unwrap();
        fs::create_dir_all(dir.path().join("tests/queries")).unwrap();
        fs::create_dir_all(dir.path().join("django")).unwrap();
        fs::write(
            dir.path().join("tests/runtests.py"),
            "import sys\nprint('ARGV=' + '|'.join(sys.argv[1:]))\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        fs::write(dir.path().join("tests/model_fields/test_imagefield.py"), "").unwrap();
        fs::write(dir.path().join("tests/queries/tests.py"), "").unwrap();

        let previous = [
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
        ];
        unsafe {
            std::env::set_var("SW_TEST_CMD", "python3 tests/runtests.py --verbosity=1");
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let output = run_test_with_args(
            &serde_json::json!({
                "path": "tests/model_fields/test_imagefield.py",
                "args": ["tests/queries/tests.py"]
            }),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(
            output.contains("ARGV=--verbosity=1|model_fields.test_imagefield|queries.tests"),
            "{}",
            output
        );
        assert!(!output.contains("|tests/queries/tests.py"), "{}", output);
    }

    #[test]
    fn run_test_uses_solver_plan_without_losing_shell_step_boundaries() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        let plan_path = dir.path().join("solver-test-plan.json");
        fs::write(
            &plan_path,
            r#"{
                "schema_version": 1,
                "runner": {"steps": [
                    {"shell": "export MODE=fast", "scope_position": "none"},
                    {"shell": "test \"$MODE\" = fast && printf 'SCOPE:%s\\n'", "scope_position": "append"}
                ]}
            }"#,
        )
        .unwrap();
        let previous = [
            (
                "SW_SOLVER_TEST_PLAN",
                std::env::var("SW_SOLVER_TEST_PLAN").ok(),
            ),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
        ];
        unsafe {
            std::env::set_var("SW_SOLVER_TEST_PLAN", &plan_path);
            std::env::remove_var("SW_TEST_CMD");
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let output = run_test_with_args(
            &serde_json::json!({"path": "tests/test value.py"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.contains("SCOPE:tests/test value.py"), "{}", output);
        assert!(output.contains("SW_TEST_EXIT_CODE=0"), "{}", output);
    }

    #[test]
    fn run_test_normalizes_existing_file_alias_to_scoped_test_file() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("tests")).unwrap();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("tests/test_probe.py"),
            "def test_probe(): pass\n",
        )
        .unwrap();
        write_executable(
            &dir.path().join("probe.sh"),
            "#!/bin/sh\necho \"ARGV=$*\"\n",
        );
        let previous = [
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
        ];
        unsafe {
            std::env::set_var("SW_TEST_CMD", "./probe.sh");
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let output = run_test_with_args(
            &serde_json::json!({"file": "tests/test_probe.py"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.contains("ARGV=tests/test_probe.py"), "{}", output);
        assert!(output.contains("SW_TEST_EXIT_CODE=0"), "{}", output);
    }

    #[test]
    fn detect_language_python_pyproject() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("pyproject.toml"),
            "[project]\nname = \"test\"",
        )
        .unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "python");
    }

    #[test]
    fn detect_language_python_setup_py() {
        let dir = tmp_dir();
        fs::write(dir.path().join("setup.py"), "from setuptools import setup").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "python");
    }

    #[test]
    fn detect_language_go() {
        let dir = tmp_dir();
        fs::write(dir.path().join("go.mod"), "module github.com/test/test").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "go");
    }

    #[test]
    fn detect_language_rust() {
        let dir = tmp_dir();
        fs::write(dir.path().join("Cargo.toml"), "[package]\nname = \"test\"").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "rust");
    }

    #[test]
    fn detect_language_typescript() {
        let dir = tmp_dir();
        fs::write(dir.path().join("tsconfig.json"), "{}").unwrap();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "typescript");
    }

    #[test]
    fn detect_language_javascript() {
        let dir = tmp_dir();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "javascript");
    }

    #[test]
    fn detect_language_fallback_extension() {
        let dir = tmp_dir();
        fs::write(dir.path().join("main.go"), "package main").unwrap();
        fs::write(dir.path().join("util.go"), "package main").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "go");
    }

    #[test]
    fn detect_language_unknown() {
        let dir = tmp_dir();
        fs::write(dir.path().join("README.md"), "# Hello").unwrap();
        assert_eq!(detect_language(dir.path().to_str().unwrap()), "unknown");
    }

    #[test]
    fn format_test_output_keeps_sklearn_check_build_import_miss_as_feedback() {
        let output = format_test_command_output(
            "python",
            "python3",
            &[
                "-m".to_string(),
                "pytest".to_string(),
                "sklearn/cluster/tests/test_affinity_propagation.py".to_string(),
            ],
            "ModuleNotFoundError: No module named 'sklearn.__check_build._check_build'\n",
            4,
            false,
            false,
            false,
            120,
        );

        assert!(!output.starts_with("TEST_ENV_UNAVAILABLE:"));
        assert!(output.contains("SW_TEST_ENV_UNAVAILABLE=0"));
        assert!(output.contains("sklearn.__check_build"));
    }

    #[test]
    fn run_test_missing_runner_reports_typed_env_unavailable() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        let previous = [
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
        ];
        unsafe {
            std::env::set_var("SW_TEST_CMD", "./definitely-missing-test-runner");
            std::env::remove_var("SW_EVAL_IMAGE");
        }

        let output = run_test_with_args(
            &serde_json::json!({"path": "tests/test_missing.py"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }

        assert!(output.starts_with("TEST_ENV_UNAVAILABLE:"), "{}", output);
        assert!(output.contains("SW_TEST_EXIT_CODE=-1"), "{}", output);
        assert!(output.contains("SW_TEST_ENV_UNAVAILABLE=1"), "{}", output);
        assert!(
            output.contains("SW_TEST_SCOPE_AUTHORITY=untrusted"),
            "{}",
            output
        );
        assert!(output.contains("SW_TEST_SCOPE_TRUSTED=0"), "{}", output);
        assert!(output.contains("SW_TEST_CAN_COMPLETE=0"), "{}", output);
        assert!(output.contains("SW_TEST_COMMAND="), "{}", output);
    }

    #[test]
    fn run_test_preflight_unavailable_reports_typed_markers() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let previous = std::env::var("SW_TEST_PREFLIGHT_UNAVAILABLE").ok();
        unsafe {
            std::env::set_var("SW_TEST_PREFLIGHT_UNAVAILABLE", "1");
        }

        let output = run_test_with_args(&serde_json::json!({}), dir.path().to_str().unwrap());

        restore_test_env("SW_TEST_PREFLIGHT_UNAVAILABLE", previous);
        assert!(output.starts_with("TEST_ENV_UNAVAILABLE:"), "{}", output);
        assert!(output.contains("SW_TEST_EXIT_CODE=-1"), "{}", output);
        assert!(output.contains("SW_TEST_ENV_UNAVAILABLE=1"), "{}", output);
        assert!(
            output.contains("SW_TEST_SCOPE_AUTHORITY=untrusted"),
            "{}",
            output
        );
        assert!(output.contains("SW_TEST_SCOPE_TRUSTED=0"), "{}", output);
        assert!(output.contains("SW_TEST_CAN_COMPLETE=0"), "{}", output);
    }

    #[test]
    fn run_test_js_install_failure_reports_typed_env_unavailable() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"jest"}}"#,
        )
        .unwrap();
        write_executable(
            &bin_dir.join("npm"),
            "#!/bin/sh\necho install failed >&2\nexit 42\n",
        );
        let previous = [
            ("PATH", std::env::var("PATH").ok()),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
        ];
        let path = format!(
            "{}:{}",
            bin_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        unsafe {
            std::env::set_var("PATH", path);
            std::env::remove_var("SW_TEST_CMD");
        }

        let output = run_test_with_args(
            &serde_json::json!({"path": "tests/example.test.js"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.starts_with("TEST_ENV_UNAVAILABLE:"), "{}", output);
        assert!(output.contains("dependency install failed"), "{}", output);
        assert!(
            output.contains("SW_TEST_SCOPE_AUTHORITY=untrusted"),
            "{}",
            output
        );
        assert!(output.contains("SW_TEST_CAN_COMPLETE=0"), "{}", output);
        assert!(
            output.contains("SW_TEST_COMMAND=npm [\"install\"]"),
            "{}",
            output
        );
    }

    #[test]
    fn edit_line_missing_path_error_does_not_seed_repo_paths() {
        let dir = tmp_dir();
        let output = edit_line(
            &serde_json::json!({"old": "x", "new": "y"}),
            dir.path().to_str().unwrap(),
        );

        assert!(output.contains("requires a 'path' argument"));
        assert!(output.contains("existing repository-relative file path"));
        assert!(!output.contains("django/"));
        assert!(!output.contains("class Choices"));
    }

    #[test]
    fn edit_line_matches_whitespace_normalized_current_line() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("module.py"),
            "def f():\n    result = call(1, 2)\n",
        )
        .unwrap();

        let output = edit_line(
            &serde_json::json!({
                "path": "module.py",
                "old": "result    =    call(1,    2)",
                "new": "result = call(2, 3)"
            }),
            dir.path().to_str().unwrap(),
        );

        assert!(output.contains("changed"));
        let content = fs::read_to_string(dir.path().join("module.py")).unwrap();
        assert!(content.contains("    result = call(2, 3)"));
    }

    #[test]
    fn edit_line_uses_hint_local_fuzzy_match_for_small_drift() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("module.py"),
            "def f():\n    return resolver(request.get_full_path(), urlconf)\n",
        )
        .unwrap();

        let output = edit_line(
            &serde_json::json!({
                "path": "module.py",
                "line": 2,
                "old": "return resolve(request.get_full_path(), urlconf)",
                "new": "return resolver(request.get_full_path() + '/', urlconf)"
            }),
            dir.path().to_str().unwrap(),
        );

        assert!(output.contains("fuzzy changed"), "{}", output);
        let content = fs::read_to_string(dir.path().join("module.py")).unwrap();
        assert!(content.contains("return resolver(request.get_full_path() + '/', urlconf)"));
    }

    #[test]
    fn run_test_blocks_unscoped_eval_image_without_probe_mode() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        *UNSCOPED_TEST_PROBE_USED.lock().unwrap() = false;
        let dir = tmp_dir();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        write_executable(
            &dir.path().join("probe.sh"),
            "#!/bin/sh\necho 'SHOULD_NOT_RUN'\n",
        );

        let previous = [
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            (
                "SW_TEST_UNSCOPED_PROBE",
                std::env::var("SW_TEST_UNSCOPED_PROBE").ok(),
            ),
        ];
        unsafe {
            std::env::set_var("SW_EVAL_IMAGE", "1");
            std::env::set_var("SW_TEST_CMD", "./probe.sh");
            std::env::remove_var("SW_TEST_UNSCOPED_PROBE");
        }

        let output = run_test_with_args(&serde_json::json!({}), dir.path().to_str().unwrap());

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.contains("unscoped eval-image run_test is disabled"));
        assert!(output.contains("SW_TEST_UNSCOPED_BLOCKED=1"));
        assert!(!output.contains("SHOULD_NOT_RUN"));
    }

    #[test]
    fn run_test_wraps_eval_image_python_repo_commands_with_conda() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        write_executable(
            &bin_dir.join("conda"),
            "#!/bin/sh\necho \"CONDA_ARGS=$*\"\n",
        );
        write_executable(
            &dir.path().join("probe.sh"),
            "#!/bin/sh\necho SHOULD_NOT_RUN_DIRECTLY\n",
        );

        let previous = [
            ("PATH", std::env::var("PATH").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_TEST_CONDA_ENV", std::env::var("SW_TEST_CONDA_ENV").ok()),
        ];
        let path = format!(
            "{}:{}",
            bin_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        unsafe {
            std::env::set_var("PATH", path);
            std::env::set_var("SW_EVAL_IMAGE", "1");
            std::env::set_var("SW_TEST_CMD", "./probe.sh");
            std::env::set_var("SW_TEST_CONDA_ENV", "testbed");
        }

        let output = run_test_with_args(
            &serde_json::json!({"path": "tests/test_probe.py"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.contains("SW_TEST_COMMAND=conda"), "{}", output);
        assert!(output.contains("SW_TEST_SCOPE_TRUSTED=0"), "{}", output);
        assert!(
            output.contains(
                "CONDA_ARGS=run -n testbed --no-capture-output ./probe.sh tests/test_probe.py"
            ),
            "{}",
            output
        );
        assert!(!output.contains("SHOULD_NOT_RUN_DIRECTLY"), "{}", output);
    }

    #[test]
    fn format_test_command_output_marks_feedback_scope() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let previous = [
            (
                "SW_TEST_CAN_COMPLETE",
                std::env::var("SW_TEST_CAN_COMPLETE").ok(),
            ),
            (
                "SW_TEST_SCOPE_AUTHORITY",
                std::env::var("SW_TEST_SCOPE_AUTHORITY").ok(),
            ),
            (
                "SW_TEST_SCOPE_TRUSTED",
                std::env::var("SW_TEST_SCOPE_TRUSTED").ok(),
            ),
        ];
        unsafe {
            std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
            std::env::remove_var("SW_TEST_SCOPE_AUTHORITY");
            std::env::set_var("SW_TEST_SCOPE_TRUSTED", "1");
        }

        let output = format_test_command_output(
            "python",
            "pytest",
            &["tests/test_example.py".to_string()],
            "1 passed\n",
            0,
            false,
            false,
            false,
            42,
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }

        assert!(output.contains("SW_TEST_SCOPE_AUTHORITY=feedback"));
        assert!(output.contains("SW_TEST_SCOPE_TRUSTED=0"));
        assert!(output.contains("SW_TEST_CAN_COMPLETE=0"));
    }

    #[test]
    fn run_test_extracts_eval_command_env_assignments_before_conda_wrap() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        write_executable(
            &bin_dir.join("conda"),
            "#!/bin/sh\necho \"CONDA_ARGS=$*\"\necho \"PYTHONWARNINGS=$PYTHONWARNINGS\"\n",
        );
        write_executable(
            &dir.path().join("probe.sh"),
            "#!/bin/sh\necho SHOULD_NOT_RUN_DIRECTLY\n",
        );

        let previous = [
            ("PATH", std::env::var("PATH").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            ("SW_TEST_CONDA_ENV", std::env::var("SW_TEST_CONDA_ENV").ok()),
        ];
        let path = format!(
            "{}:{}",
            bin_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        unsafe {
            std::env::set_var("PATH", path);
            std::env::set_var("SW_EVAL_IMAGE", "1");
            std::env::set_var(
                "SW_TEST_CMD",
                "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' ./probe.sh",
            );
            std::env::set_var("SW_TEST_CONDA_ENV", "testbed");
        }

        let output = run_test_with_args(
            &serde_json::json!({"path": "sympy/printing/tests/test_pycode.py"}),
            dir.path().to_str().unwrap(),
        );

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(output.contains("SW_TEST_COMMAND=conda"), "{}", output);
        assert!(
            output.contains(
                "CONDA_ARGS=run -n testbed --no-capture-output ./probe.sh sympy/printing/tests/test_pycode.py"
            ),
            "{}",
            output
        );
        assert!(
            output.contains("PYTHONWARNINGS=ignore::UserWarning,ignore::SyntaxWarning"),
            "{}",
            output
        );
        assert!(
            !output.contains("CONDA_ARGS=run -n testbed --no-capture-output PYTHONWARNINGS="),
            "{}",
            output
        );
        assert!(!output.contains("SHOULD_NOT_RUN_DIRECTLY"), "{}", output);
    }

    #[test]
    fn unscoped_probe_stops_after_streamed_failure_signal() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        *UNSCOPED_TEST_PROBE_USED.lock().unwrap() = false;
        let dir = tmp_dir();
        fs::write(
            dir.path().join("setup.py"),
            "from setuptools import setup\n",
        )
        .unwrap();
        write_executable(
            &dir.path().join("probe.sh"),
            "#!/bin/sh\necho 'FAIL: test_streamed_failure (tests.test_probe.ProbeCase)'\nsleep 10\necho 'TOO_LATE'\n",
        );

        let previous = [
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
            ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
            (
                "SW_TEST_UNSCOPED_PROBE",
                std::env::var("SW_TEST_UNSCOPED_PROBE").ok(),
            ),
            (
                "SW_TEST_TIMEOUT_SECONDS",
                std::env::var("SW_TEST_TIMEOUT_SECONDS").ok(),
            ),
            (
                "SW_TEST_STOP_ON_FAILURE",
                std::env::var("SW_TEST_STOP_ON_FAILURE").ok(),
            ),
            (
                "SW_TEST_FAILURE_CONTEXT_SECONDS",
                std::env::var("SW_TEST_FAILURE_CONTEXT_SECONDS").ok(),
            ),
        ];
        unsafe {
            std::env::set_var("SW_EVAL_IMAGE", "1");
            std::env::set_var("SW_TEST_CMD", "./probe.sh");
            std::env::set_var("SW_TEST_UNSCOPED_PROBE", "1");
            std::env::set_var("SW_TEST_TIMEOUT_SECONDS", "30");
            std::env::set_var("SW_TEST_STOP_ON_FAILURE", "1");
            std::env::set_var("SW_TEST_FAILURE_CONTEXT_SECONDS", "1");
        }

        let started = Instant::now();
        let output = run_test_with_args(&serde_json::json!({}), dir.path().to_str().unwrap());
        let elapsed = started.elapsed();

        for (name, value) in previous {
            restore_test_env(name, value);
        }
        assert!(elapsed < Duration::from_secs(5), "elapsed: {:?}", elapsed);
        assert!(output.contains("FAIL: test_streamed_failure"));
        assert!(output.contains("SW_TEST_EARLY_STOPPED=1"));
        assert!(output.contains("SW_TEST_SCOPE_TRUSTED=0"));
        assert!(!output.contains("TOO_LATE"));
    }

    #[test]
    fn detect_js_vitest_config() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"vitest"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("vitest.config.ts"), "").unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        // Falls back to npx if pnpm not installed
        assert!(
            cmd == "pnpm" || cmd == "npx",
            "expected pnpm or npx, got {}",
            cmd
        );
        assert_eq!(args, vec!["vitest", "run"]);
    }

    #[test]
    fn detect_js_jest() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"jest --coverage"}}"#,
        )
        .unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        assert!(
            cmd == "npx" || cmd == "npm",
            "expected npx or npm, got {}",
            cmd
        );
        assert_eq!(args, vec!["jest", "--verbose"]);
    }

    #[test]
    fn detect_js_yarn() {
        let dir = tmp_dir();
        fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("yarn.lock"), "").unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        // Falls back to npx if yarn not installed
        assert!(
            cmd == "yarn" || cmd == "npx",
            "expected yarn or npx, got {}",
            cmd
        );
        assert_eq!(args, vec!["vitest", "run"]);
    }

    #[test]
    fn snapshot_restore_handles_nested_files_and_new_file_cleanup() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("pkg/sub")).unwrap();
        fs::write(dir.path().join("pkg/sub/module.py"), "value = 1\n").unwrap();
        fs::write(dir.path().join("README.md"), "hello\n").unwrap();

        let snapshot = snapshot_all(dir.path().to_str().unwrap());

        fs::write(dir.path().join("pkg/sub/module.py"), "value = 2\n").unwrap();
        fs::write(dir.path().join("pkg/sub/new.py"), "created = True\n").unwrap();

        restore_from_snapshot(dir.path().to_str().unwrap(), &snapshot);

        let restored = fs::read_to_string(dir.path().join("pkg/sub/module.py")).unwrap();
        assert_eq!(restored, "value = 1\n");
        assert!(!dir.path().join("pkg/sub/new.py").exists());
    }

    #[test]
    fn eval_image_restore_preserves_manifest_setup_artifacts() {
        let _env_lock = ENV_TEST_LOCK.lock().unwrap();
        let _lock = SNAPSHOT_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let workdir = dir.path();
        fs::create_dir_all(workdir.join("sklearn/__check_build")).unwrap();
        fs::write(workdir.join(".gitignore"), "*.so\n").unwrap();
        fs::write(workdir.join("sklearn/base.py"), "value = 1\n").unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["add", ".gitignore", "sklearn/base.py"])
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "user.name=Test",
                    "commit",
                    "-m",
                    "baseline",
                ])
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );

        let artifact = "sklearn/__check_build/_check_build.so";
        fs::write(workdir.join(artifact), b"compiled extension").unwrap();
        let manifest = workdir.join("solver-validation-manifest.json");
        fs::write(
            &manifest,
            format!(
                "{{\"protected_setup_artifacts\":[\"{}\"],\"baseline_runnable_scopes\":[]}}\n",
                artifact
            ),
        )
        .unwrap();

        let previous_eval = std::env::var("SW_EVAL_IMAGE").ok();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        unsafe {
            std::env::set_var("SW_EVAL_IMAGE", "1");
            std::env::set_var(
                "SW_VALIDATION_MANIFEST",
                manifest.to_string_lossy().to_string(),
            );
        }

        let snapshot = snapshot_all(workdir.to_str().unwrap());
        fs::write(workdir.join("sklearn/base.py"), "value = 2\n").unwrap();
        fs::write(workdir.join("scratch.py"), "temporary = True\n").unwrap();

        restore_from_snapshot(workdir.to_str().unwrap(), &snapshot);

        restore_test_env("SW_EVAL_IMAGE", previous_eval);
        restore_test_env("SW_VALIDATION_MANIFEST", previous_manifest);

        assert_eq!(
            fs::read_to_string(workdir.join("sklearn/base.py")).unwrap(),
            "value = 1\n"
        );
        assert!(workdir.join(artifact).exists());
        assert!(!workdir.join("scratch.py").exists());
    }

    #[test]
    fn snapshot_restore_recreates_deleted_file() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/file.txt"), "original\n").unwrap();

        let snapshot = snapshot_all(dir.path().to_str().unwrap());
        fs::remove_file(dir.path().join("nested/file.txt")).unwrap();

        restore_from_snapshot(dir.path().to_str().unwrap(), &snapshot);

        let restored = fs::read_to_string(dir.path().join("nested/file.txt")).unwrap();
        assert_eq!(restored, "original\n");
    }

    #[test]
    fn snapshot_restore_preserves_tracked_unicode_paths() {
        let _lock = SNAPSHOT_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        let workdir = dir.path();
        let unicode_path = workdir.join("tests/staticfiles_tests/apps/test/static/test/⊗.txt");
        fs::create_dir_all(unicode_path.parent().unwrap()).unwrap();
        fs::write(&unicode_path, "⊗ in the app dir\n").unwrap();
        fs::write(workdir.join("source.py"), "value = 1\n").unwrap();

        assert!(
            Command::new("git")
                .arg("init")
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["add", "."])
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "user.name=Test",
                    "commit",
                    "-m",
                    "baseline",
                ])
                .current_dir(workdir)
                .status()
                .unwrap()
                .success()
        );

        let snapshot = snapshot_all(workdir.to_str().unwrap());
        assert_eq!(snapshot.len(), 2);
        fs::write(workdir.join("source.py"), "value = 2\n").unwrap();

        restore_from_snapshot(workdir.to_str().unwrap(), &snapshot);

        assert_eq!(
            fs::read_to_string(&unicode_path).unwrap(),
            "⊗ in the app dir\n"
        );
        let output = Command::new("git")
            .args(["diff", "--name-status"])
            .current_dir(workdir)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).trim().is_empty(),
            "restore should leave no tracked diff, got {}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn diff_stats_counts_deleted_snapshotted_file() {
        let _lock = SNAPSHOT_TEST_LOCK.lock().unwrap();
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("pkg")).unwrap();
        fs::write(dir.path().join("pkg/deleted.py"), "one\ntwo\n").unwrap();

        snapshot_files(dir.path().to_str().unwrap());
        fs::remove_file(dir.path().join("pkg/deleted.py")).unwrap();

        let (changed, total) = diff_stats("pkg/deleted.py", dir.path().to_str().unwrap());
        assert_eq!(changed, 2);
        assert_eq!(total, 2);
        assert_eq!(
            all_diff_stats(dir.path().to_str().unwrap()),
            vec![("pkg/deleted.py".to_string(), 2, 2)]
        );
    }

    #[test]
    fn snapshots_are_isolated_by_workdir() {
        let first = tmp_dir();
        let second = tmp_dir();
        fs::write(first.path().join("first.py"), "value = 1\n").unwrap();
        fs::write(second.path().join("second.py"), "value = 2\n").unwrap();

        snapshot_files(first.path().to_str().unwrap());
        snapshot_files(second.path().to_str().unwrap());
        fs::write(first.path().join("first.py"), "value = 3\n").unwrap();
        fs::write(second.path().join("second.py"), "value = 4\n").unwrap();

        assert_eq!(
            all_diff_stats(first.path().to_str().unwrap()),
            vec![("first.py".to_string(), 2, 1)]
        );
        assert_eq!(
            all_diff_stats(second.path().to_str().unwrap()),
            vec![("second.py".to_string(), 2, 1)]
        );
    }

    #[test]
    fn snapshot_restore_preserves_binary_files() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("locale")).unwrap();
        let binary_path = dir.path().join("locale/messages.mo");
        let original = vec![0x00, 0x9f, 0xff, 0x10, 0x80];
        fs::write(&binary_path, &original).unwrap();

        let snapshot = snapshot_all(dir.path().to_str().unwrap());
        fs::remove_file(&binary_path).unwrap();

        restore_from_snapshot(dir.path().to_str().unwrap(), &snapshot);

        let restored = fs::read(&binary_path).unwrap();
        assert_eq!(restored, original);
    }

    // --- create_file tests ---

    #[test]
    fn create_file_returns_sentinel() {
        let dir = tmp_dir();
        let result = create_file(
            &serde_json::json!({"path": "new.py"}),
            dir.path().to_str().unwrap(),
        );
        assert!(result.starts_with("CREATE_FILE_READY:"));
        assert!(result.contains("new.py"));
    }

    #[test]
    fn create_file_allows_existing_parent_dir() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("pkg")).unwrap();
        let result = create_file(
            &serde_json::json!({"path": "pkg/new.py"}),
            dir.path().to_str().unwrap(),
        );
        assert!(result.starts_with("CREATE_FILE_READY:"));
        assert!(result.contains("pkg/new.py"));
    }

    #[test]
    fn create_file_blocks_missing_parent_dir() {
        let dir = tmp_dir();
        let result = create_file(
            &serde_json::json!({"path": "a/b/c/deep.py"}),
            dir.path().to_str().unwrap(),
        );
        assert!(result.contains("BLOCKED"));
        assert!(!dir.path().join("a").exists());
    }

    #[test]
    fn create_file_blocks_traversal() {
        let dir = tmp_dir();
        let result = create_file(
            &serde_json::json!({"path": "../escape.py"}),
            dir.path().to_str().unwrap(),
        );
        assert!(result.contains("traversal"));
    }

    #[test]
    fn create_file_blocks_absolute_path() {
        let dir = tmp_dir();
        let result = create_file(
            &serde_json::json!({"path": "/etc/passwd"}),
            dir.path().to_str().unwrap(),
        );
        assert!(result.contains("traversal"));
    }

    #[test]
    fn suggest_repo_paths_matches_filename_leaf() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("tests/pkg")).unwrap();
        fs::write(dir.path().join("src/pkg/abc.py"), "x = 1\n").unwrap();
        fs::write(dir.path().join("tests/pkg/abc.py"), "x = 2\n").unwrap();
        fs::write(dir.path().join("src/pkg/other.py"), "x = 3\n").unwrap();

        let suggestions =
            suggest_repo_paths("/non-existent/path/to/abc.py", dir.path().to_str().unwrap());

        assert_eq!(suggestions, vec!["src/pkg/abc.py", "tests/pkg/abc.py"]);
    }

    #[test]
    fn suggest_repo_paths_recovers_small_filename_typo() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("django/db/models/sql")).unwrap();
        fs::write(
            dir.path().join("django/db/models/sql/compiler.py"),
            "x = 1\n",
        )
        .unwrap();

        let suggestions = suggest_repo_paths(
            "django/db/models/sql/complier.py",
            dir.path().to_str().unwrap(),
        );

        assert_eq!(
            suggestions.first().map(String::as_str),
            Some("django/db/models/sql/compiler.py")
        );
    }

    #[test]
    fn suggest_repo_paths_uses_package_overlap_for_stem_match() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("sklearn/pipeline")).unwrap();
        fs::create_dir_all(dir.path().join("tests/pipeline")).unwrap();
        fs::write(dir.path().join("sklearn/pipeline/_base.py"), "x = 1\n").unwrap();
        fs::write(dir.path().join("tests/pipeline/test_base.py"), "x = 2\n").unwrap();

        let suggestions = suggest_repo_paths(
            "/wrong/sklearn/pipeline/base.py",
            dir.path().to_str().unwrap(),
        );

        assert_eq!(
            suggestions.first().map(String::as_str),
            Some("sklearn/pipeline/_base.py")
        );
    }

    #[test]
    fn write_blocked_message_includes_leaf_matches() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src/pkg")).unwrap();
        fs::write(dir.path().join("src/pkg/abc.py"), "x = 1\n").unwrap();

        let message = write_blocked_message("/missing/abc.py", dir.path().to_str().unwrap());
        assert!(message.contains("Closest leaf matches"));
        assert!(message.contains("src/pkg/abc.py"));
    }

    #[test]
    fn mutating_tool_does_not_redirect_a_missing_path_to_unique_basename() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src/pkg")).unwrap();
        let real = dir.path().join("src/pkg/abc.py");
        fs::write(&real, "x = 1\n").unwrap();

        let result = execute_tool(
            "edit_line",
            &serde_json::json!({"path": "wrong/pkg/abc.py", "old": "x = 1", "new": "x = 2"}),
            dir.path().to_str().unwrap(),
        );

        assert!(result.contains("not an existing file"));
        assert_eq!(fs::read_to_string(real).unwrap(), "x = 1\n");
    }

    #[test]
    fn read_tool_can_follow_a_unique_existing_path_suggestion() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src/pkg")).unwrap();
        fs::write(dir.path().join("src/pkg/abc.py"), "x = 1\n").unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["add", "."])
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        );

        let result = execute_tool(
            "read_file",
            &serde_json::json!({"path": "wrong/pkg/abc.py"}),
            dir.path().to_str().unwrap(),
        );

        assert!(result.contains("x = 1"));
    }

    #[test]
    fn raw_patch_without_exact_file_marker_is_rejected() {
        let dir = tmp_dir();
        let real = dir.path().join("module.py");
        fs::write(&real, "x = 1\n").unwrap();

        let result = execute_tool(
            "apply_patch",
            &serde_json::json!({"patch": "-x = 1\n+x = 2\n"}),
            dir.path().to_str().unwrap(),
        );

        assert!(result.contains("ambiguous patch"));
        assert_eq!(fs::read_to_string(real).unwrap(), "x = 1\n");
    }

    #[test]
    fn validate_existing_repo_file_suggests_for_absolute_wrong_path() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src/pkg")).unwrap();
        fs::write(dir.path().join("src/pkg/abc.py"), "x = 1\n").unwrap();

        let err = validate_existing_repo_file(
            "/non-existent/path/to/abc.py",
            dir.path().to_str().unwrap(),
        )
        .unwrap_err();

        assert!(err.contains("outside the repository"));
        assert!(err.contains("Closest leaf matches"));
        assert!(err.contains("src/pkg/abc.py"));
    }

    // --- strip_code_fences tests ---

    #[test]
    fn strip_fences_python() {
        let input = "```python\ndef hello():\n    pass\n```";
        assert_eq!(strip_code_fences(input), "def hello():\n    pass");
    }

    #[test]
    fn strip_fences_bare() {
        let input = "```\nsome code\n```";
        assert_eq!(strip_code_fences(input), "some code");
    }

    #[test]
    fn strip_fences_no_fences() {
        let input = "def hello():\n    pass";
        assert_eq!(strip_code_fences(input), "def hello():\n    pass");
    }

    #[test]
    fn strip_fences_preserves_inner_backticks() {
        let input = "```go\nfmt.Println(`hello`)\n```";
        assert_eq!(strip_code_fences(input), "fmt.Println(`hello`)");
    }

    // --- Raw file block extraction tests ---

    #[test]
    fn extract_file_blocks_single() {
        let dir = tmp_dir();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/blend.py"), "# old\n").unwrap();
        let response = r#"I'll write the implementation now.

<write_file path="src/blend.py">
class BlendRange:
    def __init__(self):
        self.black = (0, 255)
        self.white = (0, 255)
</write_file>

Now I'll run the tests."#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "src/blend.py");
        let content = fs::read_to_string(dir.path().join("src/blend.py")).unwrap();
        assert!(content.contains("class BlendRange:"));
        assert!(content.contains("self.black = (0, 255)"));
    }

    #[test]
    fn extract_file_blocks_multiple() {
        let dir = tmp_dir();
        fs::write(dir.path().join("a.py"), "# old a\n").unwrap();
        fs::write(dir.path().join("b.py"), "# old b\n").unwrap();
        let response = r#"<write_file path="a.py">
def hello():
    pass
</write_file>

<write_file path="b.py">
def world():
    pass
</write_file>"#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 2);
        assert!(dir.path().join("a.py").exists());
        assert!(dir.path().join("b.py").exists());
    }

    #[test]
    fn extract_file_blocks_none() {
        let dir = tmp_dir();
        let response = r#"{"tool_calls": [{"name": "read_file", "args": {"path": "main.py"}}]}"#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn extract_file_blocks_blocks_missing_parent_dirs() {
        let dir = tmp_dir();
        let response = r#"<write_file path="deep/nested/dir/module.py">
x = 1
</write_file>"#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 0);
        assert!(!dir.path().join("deep").exists());
        let errors = extract_file_block_errors(response, dir.path().to_str().unwrap());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("BLOCKED"));
    }

    #[test]
    fn extract_file_blocks_preserves_indentation() {
        let dir = tmp_dir();
        fs::write(dir.path().join("indented.py"), "# old\n").unwrap();
        let response = r#"<write_file path="indented.py">
class Foo:
    def bar(self):
        if True:
            return 42
</write_file>"#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 1);
        let content = fs::read_to_string(dir.path().join("indented.py")).unwrap();
        assert!(content.contains("    def bar(self):"));
        assert!(content.contains("            return 42"));
    }

    #[test]
    fn extract_file_blocks_strips_leading_blank_line() {
        let dir = tmp_dir();
        fs::write(dir.path().join("clean.py"), "# old\n").unwrap();
        // The opening tag is followed by a newline, content shouldn't start with blank line
        let response = "<write_file path=\"clean.py\">\ndef f():\n    pass\n</write_file>";
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 1);
        let content = fs::read_to_string(dir.path().join("clean.py")).unwrap();
        assert!(
            content.starts_with("def f():"),
            "content was: {:?}",
            content
        );
    }

    #[test]
    fn task_reproducer_rejects_unbound_pytest_before_runner_lookup() {
        let output = write_task_reproducer(
            &serde_json::json!({
                "name": "test_bug.py",
                "source": "def test_bug():\n    with pytest.raises(IndexError):\n        identify_format()\n"
            }),
            ".",
        );
        assert!(output.contains("uses `pytest.` without importing `pytest`"));
        assert!(output.contains("SW_TASK_REPRODUCER_STATUS=no_causal_oracle"));
        assert!(!output.contains("solver_safe_test_plan_missing"));
    }

    #[test]
    fn task_reproducer_tool_qualifies_baseline_and_records_candidate_delta() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let repo = tmp_dir();
        let artifacts = tmp_dir();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(repo.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["config", "user.name", "Test"]);
        fs::write(repo.path().join("source.py"), "VALUE = 1\n").unwrap();
        git(&["add", "source.py"]);
        git(&["commit", "-m", "baseline"]);
        fs::write(repo.path().join("source.py"), "VALUE = 2\n").unwrap();
        let plan = artifacts.path().join("solver-test-plan.json");
        fs::write(
            &plan,
            r#"{"schema_version":1,"runner":{"steps":[{"shell":"python","scope_position":"append"}]}}"#,
        )
        .unwrap();
        let previous = [
            (
                "SW_SOLVER_TEST_PLAN",
                std::env::var("SW_SOLVER_TEST_PLAN").ok(),
            ),
            ("SW_ARTIFACT_DIR", std::env::var("SW_ARTIFACT_DIR").ok()),
            ("SW_EVAL_IMAGE", std::env::var("SW_EVAL_IMAGE").ok()),
        ];
        unsafe {
            std::env::set_var("SW_SOLVER_TEST_PLAN", &plan);
            std::env::set_var("SW_ARTIFACT_DIR", artifacts.path());
            std::env::remove_var("SW_EVAL_IMAGE");
        }
        set_task_reproducer_issue("Fix VALUE behavior");
        let guard =
            enable_validation_sandbox(repo.path().to_str().unwrap(), artifacts.path()).unwrap();
        let qualified = execute_tool(
            "write_task_reproducer",
            &serde_json::json!({
                "name": "test_task_reproducer.py",
                "source": "import source\nassert source.VALUE == 2\n"
            }),
            repo.path().to_str().unwrap(),
        );
        assert!(qualified.contains("QUALIFIED"), "{qualified}");
        let candidate = execute_tool(
            "run_task_reproducer",
            &serde_json::json!({}),
            repo.path().to_str().unwrap(),
        );
        assert!(
            candidate.contains("SW_TASK_REPRODUCER_DELTA=fixed"),
            "{candidate}"
        );
        assert!(!repo.path().join(".statewright-reproducer").exists());
        assert!(
            artifacts
                .path()
                .join("task-reproducers/test_task_reproducer.py")
                .is_file()
        );
        assert!(artifacts.path().join("test-evidence.jsonl").is_file());
        drop(guard);
        *ACTIVE_TASK_REPRODUCER.lock().unwrap() = None;
        for (name, value) in previous {
            restore_test_env(name, value);
        }
    }
}
