use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

/// File snapshots taken before implementing — used for diff/minimize.
static SNAPSHOTS: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Snapshot all files in the working directory. Returns owned map for restore.
pub fn snapshot_all(workdir: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(workdir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    result.insert(name, content);
                }
            }
        }
    }
    result
}

/// Snapshot files into the internal store (for diff tool, called when entering implementing).
pub fn snapshot_files(workdir: &str) {
    let mut snaps = SNAPSHOTS.lock().unwrap();
    snaps.clear();

    if let Ok(entries) = std::fs::read_dir(workdir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    snaps.insert(name, content);
                }
            }
        }
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
    // Return original — let the tool report the error
    path.to_string()
}

/// Rewrite path arguments in a tool call's args, applying resolve_path.
fn resolve_args_paths(args: &Value, workdir: &str) -> Value {
    let mut args = args.clone();
    if let Some(obj) = args.as_object_mut() {
        if let Some(p) = obj.get("path").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            obj.insert("path".to_string(), Value::String(resolve_path(&p, workdir)));
        }
        if let Some(p) = obj.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            obj.insert("file".to_string(), Value::String(resolve_path(&p, workdir)));
        }
    }
    args
}

/// Execute a tool call against the working directory.
pub fn execute_tool(name: &str, args: &Value, workdir: &str) -> String {
    let args = &resolve_args_paths(args, workdir);
    match name {
        "read_file" => read_file(args, workdir),
        "write_file" => write_file(args, workdir),
        "list_directory" => list_directory(args, workdir),
        "run_test" => run_test_with_args(args, workdir),
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
                return format!("File '{}' does not exist. To create a new file, use write_file.", path);
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

    let start_line = args.get("start_line").or_else(|| args.get("line_start"))
        .and_then(|l| l.as_u64()).map(|l| l as usize);
    let end_line = args.get("end_line").or_else(|| args.get("line_end"))
        .and_then(|l| l.as_u64()).map(|l| l as usize);

    match std::fs::read_to_string(&canonical) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();

            match (start_line, end_line) {
                (Some(start), Some(end)) => {
                    let s = start.saturating_sub(1).min(total);
                    let e = end.min(total);
                    let selected: Vec<String> = lines[s..e].iter().enumerate()
                        .map(|(i, l)| format!("{:>4}: {}", s + i + 1, l))
                        .collect();
                    format!("(lines {}-{} of {})\n{}", s + 1, e, total, selected.join("\n"))
                }
                (Some(start), None) => {
                    let s = start.saturating_sub(1).min(total);
                    let selected: Vec<String> = lines[s..].iter().enumerate()
                        .map(|(i, l)| format!("{:>4}: {}", s + i + 1, l))
                        .collect();
                    format!("(lines {}-{} of {})\n{}", s + 1, total, total, selected.join("\n"))
                }
                _ => {
                    // No range — return with line numbers for large files
                    if total > 100 {
                        let numbered: Vec<String> = lines.iter().enumerate()
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

fn write_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };
    let content = match args.get("content").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return "error: missing 'content' argument".into(),
    };

    let full_path = Path::new(workdir).join(path);

    // Create parent directories if needed (for new files in new dirs)
    if let Some(parent) = full_path.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return format!("error creating directory for '{}': {}", path, e);
            }
        }
        // Path traversal check
        if let Ok(workdir_canonical) = Path::new(workdir).canonicalize() {
            if let Ok(parent_canonical) = parent.canonicalize() {
                if !parent_canonical.starts_with(&workdir_canonical) {
                    return "error: path traversal detected".into();
                }
            }
        }
    }

    match std::fs::write(&full_path, content) {
        Ok(()) => format!("wrote {} bytes to {}", content.len(), path),
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Phase 1 of two-phase file write. Validates path, creates parent dirs,
/// returns a sentinel that the harness intercepts to trigger the content phase.
/// The harness prompts the model for raw file content in a separate LLM call.
fn create_file(args: &Value, workdir: &str) -> String {
    let path = match args.get("path").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'path' argument".into(),
    };

    if path.contains("..") || path.starts_with('/') {
        return "error: path traversal detected".into();
    }

    let full_path = Path::new(workdir).join(path);
    if let Some(parent) = full_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return format!("error creating directory for '{}': {}", path, e);
        }
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

fn run_test_with_args(args: &Value, workdir: &str) -> String {
    let test_path = args.get("path").and_then(|p| p.as_str());
    let test_file = args.get("test_file").and_then(|p| p.as_str());
    let extra_args: Vec<String> = args.get("args")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let lang = detect_language(workdir);

    let (cmd, mut cmd_args) = match lang {
        "go" => {
            let mut a = vec!["test".to_string(), "-v".to_string(), "-count=1".to_string()];
            if let Some(p) = test_path {
                a.push(format!("./{}/...", p));
            } else if let Some(f) = test_file {
                a.push(format!("./{}", std::path::Path::new(f).parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".into())));
            } else {
                a.push("./...".to_string());
            }
            a.extend(extra_args);
            ("go".to_string(), a)
        }
        "rust" => {
            let mut a = vec!["test".to_string()];
            if let Some(p) = test_path {
                a.push("--".to_string());
                a.push(p.to_string());
            }
            a.extend(extra_args);
            ("cargo".to_string(), a)
        }
        "typescript" | "javascript" => {
            let (runner, mut runner_args) = detect_js_test_runner(workdir);
            if let Some(p) = test_path {
                runner_args.push(p.to_string());
            } else if let Some(f) = test_file {
                runner_args.push(f.to_string());
            }
            runner_args.extend(extra_args);
            (runner, runner_args)
        }
        _ => {
            // Default: Python / pytest
            let mut a: Vec<String> = vec!["-m".into(), "pytest".into(), "-xvs".into(),
                "--tb=short".into(), "--no-header".into(), "-q".into()];
            if let Some(p) = test_path {
                a.push(p.to_string());
            } else if let Some(f) = test_file {
                a.push(f.to_string());
            }
            a.extend(extra_args);
            ("python3".to_string(), a)
        }
    };

    // Install deps if needed (JS/TS only, first run)
    if matches!(lang, "typescript" | "javascript") {
        let p = Path::new(workdir);
        if !p.join("node_modules").exists() && p.join("package.json").exists() {
            let pkg_mgr = if p.join("pnpm-lock.yaml").exists() && command_exists("pnpm") { "pnpm" }
                else if p.join("yarn.lock").exists() && command_exists("yarn") { "yarn" }
                else { "npm" };
            let _ = Command::new(pkg_mgr)
                .arg("install")
                .current_dir(workdir)
                .output();
        }
    }

    let output = Command::new(&cmd)
        .args(&cmd_args)
        .current_dir(workdir)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{}\n{}", stdout, stderr);
            // Truncate to prevent context blowup on huge test output
            if combined.len() > 8000 {
                let truncated = &combined[..4000];
                let tail = &combined[combined.len()-3000..];
                format!("{}...\n[truncated {} bytes]\n...{}", truncated, combined.len() - 7000, tail)
            } else {
                combined
            }
        }
        Err(e) => format!("error running tests ({}): {} — cmd: {} {:?}", lang, e, cmd, cmd_args),
    }
}

fn grep(args: &Value, workdir: &str) -> String {
    let pattern = match args.get("pattern").and_then(|p| p.as_str()) {
        Some(p) => p,
        None => return "error: missing 'pattern' argument".into(),
    };
    let file = args.get("file").and_then(|f| f.as_str());

    let mut cmd = Command::new("grep");
    cmd.args(["-rn", pattern]);
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

    let snaps = SNAPSHOTS.lock().unwrap();
    let original = match snaps.get(path) {
        Some(s) => s.clone(),
        None => return format!("error: no snapshot for '{}' — was the file created new?", path),
    };
    drop(snaps);

    let current = match std::fs::read_to_string(Path::new(workdir).join(path)) {
        Ok(c) => c,
        Err(e) => return format!("error reading current '{}': {}", path, e),
    };

    if original == current {
        return "no changes".into();
    }

    // Line-by-line diff
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
        None => return "error: missing 'path' argument".into(),
    };
    let old = args.get("old").and_then(|o| o.as_str());
    let new_content = match args.get("new").and_then(|n| n.as_str()) {
        Some(n) => n,
        None => return "error: missing 'new' argument (replacement content)".into(),
    };
    let hint_line = args.get("line").and_then(|l| l.as_u64()).map(|l| l as usize);

    // Insert mode: no 'old' but 'line' provided → insert after that line
    if old.is_none() {
        if let Some(after) = hint_line {
            let full_path = Path::new(workdir).join(path);
            let content = match std::fs::read_to_string(&full_path) {
                Ok(c) => c,
                Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
            };
            let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
            let idx = after.min(lines.len());
            // Detect indent from the target line
            let indent: String = if idx > 0 {
                lines[idx - 1].chars().take_while(|c| c.is_whitespace()).collect()
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

    let full_path = Path::new(workdir).join(path);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
    };

    let lines: Vec<&str> = content.lines().collect();
    // Unescape JSON artifacts, strip whitespace and trailing newlines
    let old_unescaped = old.replace("\\\"", "\"").replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\");
    let old_trimmed = old_unescaped.trim().lines().next().unwrap_or("").trim();

    // Find all matching lines
    let matches: Vec<usize> = lines.iter().enumerate()
        .filter(|(_, line)| line.trim() == old_trimmed)
        .map(|(i, _)| i)
        .collect();

    if matches.is_empty() {
        // Show lines that partially match to help the model
        let partial: Vec<String> = lines.iter().enumerate()
            .filter(|(_, line)| line.contains(old_trimmed) || old_trimmed.contains(line.trim()))
            .take(3)
            .map(|(i, line)| format!("  L{}: {}", i + 1, line))
            .collect();

        let hint = if partial.is_empty() {
            String::new()
        } else {
            format!("\nPartial matches:\n{}", partial.join("\n"))
        };

        return format!("error: '{}' not found in {}. Read the file to find the exact content.{}", old_trimmed, path, hint);
    }

    // Pick the right match
    let target_idx = if matches.len() == 1 {
        matches[0]
    } else if let Some(hint) = hint_line {
        // Use line hint to disambiguate
        *matches.iter()
            .min_by_key(|&&idx| (idx as isize - hint as isize).unsigned_abs())
            .unwrap()
    } else {
        // Multiple matches, no line hint — edit ALL occurrences
        let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        let new_trimmed = new_content.trim_start();
        let mut changed = Vec::new();
        for &idx in &matches {
            let indent: String = lines[idx].chars().take_while(|c| c.is_whitespace()).collect();
            new_lines[idx] = format!("{}{}", indent, new_trimmed);
            changed.push(format!("L{}", idx + 1));
        }
        let new_file = new_lines.join("\n") + "\n";
        return match std::fs::write(&full_path, &new_file) {
            Ok(()) => format!("{} changed ({}): '{}' -> '{}'", changed.len(), changed.join(", "), old_trimmed, new_content.trim()),
            Err(e) => format!("error writing '{}': {}", path, e),
        };
    };

    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();

    // Preserve original indentation: extract leading whitespace from the old line,
    // strip leading whitespace from the replacement, re-indent with the original.
    let original_line = lines[target_idx];
    let indent: String = original_line.chars().take_while(|c| c.is_whitespace()).collect();
    let new_trimmed = new_content.trim_start();
    new_lines[target_idx] = format!("{}{}", indent, new_trimmed);

    let new_file = new_lines.join("\n") + "\n";

    match std::fs::write(&full_path, &new_file) {
        Ok(()) => format!("L{} changed: '{}' -> '{}'", target_idx + 1, old_trimmed, new_content.trim()),
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
    let new_content = args.get("new").or_else(|| args.get("new_content"))
        .and_then(|n| n.as_str())
        .unwrap_or("");

    // Fallback: if 'old' is missing but start_line/end_line provided, use line-number replacement
    let old = match args.get("old").and_then(|o| o.as_str()) {
        Some(o) => o.to_string(),
        None => {
            let start = args.get("start_line").and_then(|s| s.as_u64());
            let end = args.get("end_line").and_then(|s| s.as_u64());
            if let (Some(start), Some(end)) = (start, end) {
                let full_path = Path::new(workdir).join(path);
                let content = match std::fs::read_to_string(&full_path) {
                    Ok(c) => c,
                    Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
                };
                let lines: Vec<&str> = content.lines().collect();
                let s = (start as usize).saturating_sub(1).min(lines.len());
                let e = (end as usize).min(lines.len());
                if s >= e { return "error: start_line >= end_line".into(); }
                let old_block = lines[s..e].join("\n");
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

    let full_path = Path::new(workdir).join(path);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
    };

    // Unescape JSON artifacts from native tool calling (models send \" for ")
    let old_unescaped = old
        .replace("\\\"", "\"")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\\", "\\");

    // Normalize the old block for matching: trim each line, collapse whitespace
    let old_lines: Vec<&str> = old_unescaped.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
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
            if file_lines[i + j].trim() != *old_line {
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
        for i in 0..file_lines.len() {
            if file_lines.len() - i < old_lines.len() { break; }
            if file_lines[i].trim() == first {
                // Check if last line matches within a reasonable window
                let search_end = (i + old_lines.len() + 5).min(file_lines.len());
                for end in i + 1..search_end {
                    if file_lines[end].trim() == last {
                        let span = end - i + 1;
                        // Accept if span is within 3 lines of expected
                        if span.abs_diff(old_lines.len()) <= 3 {
                            match_start = Some(i);
                            // Adjust old_lines length to match actual span
                            break;
                        }
                    }
                }
                if match_start.is_some() { break; }
            }
        }
    }

    let start = match match_start {
        Some(s) => s,
        None => {
            // Show what we were looking for
            let search_preview = old_lines.iter().take(3).cloned().collect::<Vec<_>>().join(" | ");
            return format!(
                "error: block not found in {}. Looking for: '{}'. Read the file to find the exact content.",
                path, search_preview
            );
        }
    };

    // Detect the indentation level from the first matched line
    let indent: String = file_lines[start].chars().take_while(|c| c.is_whitespace()).collect();

    // Build the replacement: apply the original indentation to each new line
    let new_lines: Vec<String> = new_content.lines().enumerate().map(|(i, line)| {
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            String::new()
        } else if i == 0 {
            // First line gets the original indent
            format!("{}{}", indent, trimmed)
        } else {
            // Subsequent lines: detect relative indent from new_content and add base indent
            let new_base_indent = new_content.lines().next()
                .map(|first| first.len() - first.trim_start().len())
                .unwrap_or(0);
            let this_indent = line.len() - trimmed.len();
            let relative = this_indent.saturating_sub(new_base_indent);
            let extra: String = " ".repeat(relative);
            format!("{}{}{}", indent, extra, trimmed)
        }
    }).collect();

    // Replace the matched range with the new lines
    let mut result_lines: Vec<String> = Vec::new();
    result_lines.extend(file_lines[..start].iter().map(|l| l.to_string()));
    result_lines.extend(new_lines);
    result_lines.extend(file_lines[start + old_lines.len()..].iter().map(|l| l.to_string()));

    let new_file = result_lines.join("\n") + "\n";
    let old_count = old_lines.len();
    let new_count = new_content.lines().count();

    match std::fs::write(&full_path, &new_file) {
        Ok(()) => {
            let mut msg = format!(
                "replaced {} lines with {} lines at L{} in {}",
                old_count, new_count, start + 1, path
            );
            // Include diff for TUI rendering
            for line in old_lines.iter().take(5) {
                msg.push_str(&format!("\n- {}", line));
            }
            if old_lines.len() > 5 { msg.push_str("\n- ..."); }
            for line in new_content.lines().take(5) {
                msg.push_str(&format!("\n+ {}", line.trim()));
            }
            if new_count > 5 { msg.push_str("\n+ ..."); }
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
        if trimmed.starts_with("*** Update File:") || trimmed.starts_with("--- a/") {
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
            // Normalize: strip leading path components to match local files
            let local_name = name.rsplit('/').next().unwrap_or(name);
            current_file = Some(local_name.to_string());
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

    // If no file markers found, try to apply as raw -/+ against all .py files
    if current_file.is_none() && (!removals.is_empty() || !additions.is_empty()) {
        // Find .py files
        if let Ok(entries) = std::fs::read_dir(workdir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".py") && !name.starts_with("test_") {
                    match apply_diff_to_file(&name, &removals, &additions, workdir) {
                        Ok(n) => { applied += n; break; }
                        Err(_) => {}
                    }
                }
            }
        }
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
    let path = Path::new(workdir).join(filename);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("can't read {}: {}", filename, e))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut applied = 0;

    // For each removal, find it and replace with the corresponding addition
    for (i, removal) in removals.iter().enumerate() {
        let removal_trimmed = removal.trim();
        if removal_trimmed.is_empty() { continue; }

        if let Some(idx) = lines.iter().position(|l| l.trim() == removal_trimmed) {
            if i < additions.len() {
                // Preserve indentation
                let indent: String = lines[idx].chars().take_while(|c| c.is_whitespace()).collect();
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

    let full_path = Path::new(workdir).join(path);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
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

        let old_unescaped = old.replace("\\\"", "\"").replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\");
        let old_trimmed = old_unescaped.trim();
        let found = lines.iter().position(|l| l.trim() == old_trimmed);

        match found {
            Some(idx) => {
                let original = lines[idx].clone();
                let indent: String = lines[idx].chars().take_while(|c| c.is_whitespace()).collect();
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
    let snaps = SNAPSHOTS.lock().unwrap();
    let original = match snaps.get(path) {
        Some(s) => s.clone(),
        None => return (0, 0),
    };
    drop(snaps);

    let current = match std::fs::read_to_string(Path::new(workdir).join(path)) {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };

    let orig_lines: Vec<&str> = original.lines().collect();

    // Use LCS-based diff to count only actually changed/inserted/deleted lines,
    // not positional shifts from insertions.
    let diff = similar::TextDiff::from_lines(&original, &current);
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
    let snaps = SNAPSHOTS.lock().unwrap();
    let files: Vec<String> = snaps.keys().cloned().collect();
    drop(snaps);

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
    let before_anchor = args.get("before").and_then(|b| b.as_str()).map(|s| s.trim());

    let full_path = Path::new(workdir).join(path);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(e) => {
                    if !std::path::Path::new(workdir).join(path).exists() {
                        return format!("File '{}' does not exist. To create a new file, use write_file.", path);
                    }
                    return format!("error reading '{}': {}", path, e);
                },
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
    let indent: String = lines[after_idx].chars().take_while(|c| c.is_whitespace()).collect();

    // Insert after the anchor line
    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let new_trimmed = new_content.trim();
    new_lines.insert(after_idx + 1, format!("{}{}", indent, new_trimmed));

    let new_file = new_lines.join("\n") + "\n";
    match std::fs::write(&full_path, &new_file) {
        Ok(()) => format!("Inserted '{}' after L{} ('{}') in {}",
            new_trimmed, after_idx + 1, after_anchor, path),
        Err(e) => format!("error writing '{}': {}", path, e),
    }
}

/// Inspect a class: show its inheritance tree, file locations, and key attributes.
/// Language-aware: Python uses AST, others fall back to grep.
fn inspect_class(args: &Value, workdir: &str) -> String {
    let class_name = match args.get("class").or(args.get("name")).and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return "error: missing 'class' argument (class name to inspect)".into(),
    };
    let check_attr = args.get("attribute").and_then(|a| a.as_str()).unwrap_or("");

    // Detect language from nearby files
    let has_py = Path::new(workdir).join("setup.py").exists()
        || Path::new(workdir).join("pyproject.toml").exists()
        || std::fs::read_dir(workdir).ok().map_or(false, |e|
            e.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().ends_with(".py")));

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
            format!("f' — {}: {{\"yes\" if has_attr else \"MISSING\"}}'", check_attr)
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

        match Command::new("python3").args(["-c", &script]).current_dir(workdir).output() {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                if !stdout.is_empty() { stdout.to_string() }
                else if !stderr.is_empty() { format!("error: {}", stderr) }
                else { format!("Class {} not found", class_name) }
            }
            Err(e) => format!("error: {}", e),
        }
    } else {
        // Non-Python: grep-based fallback
        let grep_result = Command::new("grep")
            .args(["-rn", &format!("class {}|struct {}|impl {}|type {}|interface {}",
                class_name, class_name, class_name, class_name, class_name), "."])
            .current_dir(workdir)
            .output();
        match grep_result {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.is_empty() { format!("Class {} not found", class_name) }
                else { format!("Definitions of {}:\n{}", class_name, stdout) }
            }
            Err(e) => format!("error: {}", e),
        }
    }
}

/// Search for files by name pattern (recursive).
fn find_files(args: &Value, workdir: &str) -> String {
    let pattern = args.get("pattern").and_then(|p| p.as_str()).unwrap_or("*.py");
    let output = Command::new("find")
        .args([".", "-name", pattern, "-not", "-path", "*/.git/*",
               "-not", "-path", "*/node_modules/*", "-not", "-path", "*/__pycache__/*",
               "-not", "-path", "*/target/*"])
        .current_dir(workdir)
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if stdout.is_empty() { "no files found".into() }
            else {
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
pub fn extract_file_blocks(response: &str, workdir: &str) -> Vec<(String, usize)> {
    let mut results = Vec::new();
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

        let full_path = Path::new(workdir).join(path);
        // Create parent directories
        if let Some(parent) = full_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

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

    results
}

/// Restore all snapshotted files to their original content.
pub fn restore_snapshot(workdir: &str) {
    let snaps = SNAPSHOTS.lock().unwrap();
    for (name, content) in snaps.iter() {
        let path = Path::new(workdir).join(name);
        if let Err(e) = std::fs::write(&path, content) {
            eprintln!("  [RESTORE] Failed to restore {}: {}", name, e);
        }
    }
}

/// Detect project language from manifest files and file extensions.
/// Returns "python", "go", "typescript", "javascript", "rust", or "unknown".
pub fn detect_language(workdir: &str) -> &'static str {
    let p = Path::new(workdir);
    // Manifest-based detection (most reliable)
    if p.join("Cargo.toml").exists() { return "rust"; }
    if p.join("go.mod").exists() { return "go"; }
    if p.join("tsconfig.json").exists() { return "typescript"; }
    if p.join("pyproject.toml").exists() || p.join("setup.py").exists() || p.join("setup.cfg").exists() {
        return "python";
    }
    if p.join("package.json").exists() {
        // Disambiguate JS vs TS: check for tsconfig or .ts files
        if p.join("tsconfig.json").exists() { return "typescript"; }
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
            if name.ends_with(".py") { py += 1; }
            else if name.ends_with(".go") { go += 1; }
            else if name.ends_with(".ts") || name.ends_with(".tsx") { ts += 1; }
            else if name.ends_with(".js") || name.ends_with(".jsx") { js += 1; }
            else if name.ends_with(".rs") { rs += 1; }
        }
        let max = py.max(go).max(ts).max(js).max(rs);
        if max > 0 {
            if py == max { return "python"; }
            if go == max { return "go"; }
            if ts == max { return "typescript"; }
            if js == max { return "javascript"; }
            if rs == max { return "rust"; }
        }
    }
    "unknown"
}

/// Check if a command exists on PATH.
fn command_exists(cmd: &str) -> bool {
    Command::new("which").arg(cmd).output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Pick the package manager runner, preferring the lockfile match but falling back to npx.
fn pick_js_runner(workdir: &str) -> String {
    let p = Path::new(workdir);
    if p.join("pnpm-lock.yaml").exists() && command_exists("pnpm") { "pnpm".into() }
    else if p.join("yarn.lock").exists() && command_exists("yarn") { "yarn".into() }
    else if command_exists("npx") { "npx".into() }
    else { "npm".into() }
}

/// Detect the test runner command for a TypeScript/JavaScript project.
/// Checks package.json scripts and lockfiles.
fn detect_js_test_runner(workdir: &str) -> (String, Vec<String>) {
    let p = Path::new(workdir);
    if let Ok(pkg) = std::fs::read_to_string(p.join("package.json")) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&pkg) {
            let scripts = parsed.get("scripts");
            let has_test = scripts.and_then(|s| s.get("test")).and_then(|t| t.as_str()).unwrap_or("");
            // Check for vitest config file (higher priority than package.json script)
            if p.join("vitest.config.ts").exists() || p.join("vitest.config.js").exists()
                || p.join("vitest.config.mts").exists() || has_test.contains("vitest") {
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

    fn tmp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("failed to create temp dir")
    }

    #[test]
    fn detect_language_python_pyproject() {
        let dir = tmp_dir();
        fs::write(dir.path().join("pyproject.toml"), "[project]\nname = \"test\"").unwrap();
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
    fn detect_js_vitest_config() {
        let dir = tmp_dir();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
        fs::write(dir.path().join("vitest.config.ts"), "").unwrap();
        fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        // Falls back to npx if pnpm not installed
        assert!(cmd == "pnpm" || cmd == "npx", "expected pnpm or npx, got {}", cmd);
        assert_eq!(args, vec!["vitest", "run"]);
    }

    #[test]
    fn detect_js_jest() {
        let dir = tmp_dir();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"jest --coverage"}}"#).unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        assert!(cmd == "npx" || cmd == "npm", "expected npx or npm, got {}", cmd);
        assert_eq!(args, vec!["jest", "--verbose"]);
    }

    #[test]
    fn detect_js_yarn() {
        let dir = tmp_dir();
        fs::write(dir.path().join("package.json"), r#"{"scripts":{"test":"vitest run"}}"#).unwrap();
        fs::write(dir.path().join("yarn.lock"), "").unwrap();
        let (cmd, args) = detect_js_test_runner(dir.path().to_str().unwrap());
        // Falls back to npx if yarn not installed
        assert!(cmd == "yarn" || cmd == "npx", "expected yarn or npx, got {}", cmd);
        assert_eq!(args, vec!["vitest", "run"]);
    }

    // --- create_file tests ---

    #[test]
    fn create_file_returns_sentinel() {
        let dir = tmp_dir();
        let result = create_file(&serde_json::json!({"path": "src/new.py"}), dir.path().to_str().unwrap());
        assert!(result.starts_with("CREATE_FILE_READY:"));
        assert!(result.contains("src/new.py"));
    }

    #[test]
    fn create_file_makes_parent_dirs() {
        let dir = tmp_dir();
        create_file(&serde_json::json!({"path": "a/b/c/deep.py"}), dir.path().to_str().unwrap());
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[test]
    fn create_file_blocks_traversal() {
        let dir = tmp_dir();
        let result = create_file(&serde_json::json!({"path": "../escape.py"}), dir.path().to_str().unwrap());
        assert!(result.contains("traversal"));
    }

    #[test]
    fn create_file_blocks_absolute_path() {
        let dir = tmp_dir();
        let result = create_file(&serde_json::json!({"path": "/etc/passwd"}), dir.path().to_str().unwrap());
        assert!(result.contains("traversal"));
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
    fn extract_file_blocks_creates_dirs() {
        let dir = tmp_dir();
        let response = r#"<write_file path="deep/nested/dir/module.py">
x = 1
</write_file>"#;
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 1);
        assert!(dir.path().join("deep/nested/dir/module.py").exists());
    }

    #[test]
    fn extract_file_blocks_preserves_indentation() {
        let dir = tmp_dir();
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
        // The opening tag is followed by a newline, content shouldn't start with blank line
        let response = "<write_file path=\"clean.py\">\ndef f():\n    pass\n</write_file>";
        let results = extract_file_blocks(response, dir.path().to_str().unwrap());
        assert_eq!(results.len(), 1);
        let content = fs::read_to_string(dir.path().join("clean.py")).unwrap();
        assert!(content.starts_with("def f():"), "content was: {:?}", content);
    }
}
