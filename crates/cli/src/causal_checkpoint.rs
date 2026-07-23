//! Best-candidate retention for the serial causal repair controller.
//!
//! The store never invents a success signal. It retains only a real working
//! tree diff paired with typed internal evidence, and it restores that diff
//! only at the final canonical-evaluation boundary. Unsupported worktrees
//! (for example, untracked source files) are recorded and left untouched.

use crate::{causal_validation::CausalScopeSignal, validation_oracle::TestDelta};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CheckpointEvidence {
    pub structural_pass: bool,
    pub task_scope_improved: bool,
    pub regression_pass: bool,
    pub reproducer_fixed: bool,
    pub changed_lines: usize,
}

impl CheckpointEvidence {
    fn quality(&self) -> (u8, u8, u8, u8) {
        (
            u8::from(self.reproducer_fixed),
            u8::from(self.task_scope_improved),
            u8::from(self.regression_pass),
            u8::from(self.structural_pass),
        )
    }

    fn is_evidence_backed(&self) -> bool {
        self.structural_pass
            || self.task_scope_improved
            || self.regression_pass
            || self.reproducer_fixed
    }

    fn observe_scope(&mut self, signal: CausalScopeSignal) {
        match signal {
            CausalScopeSignal::StructuralPass => self.structural_pass = true,
            CausalScopeSignal::TaskScopeImproved => {
                self.structural_pass = true;
                self.task_scope_improved = true;
            }
            CausalScopeSignal::RegressionPass => {
                self.structural_pass = true;
                self.regression_pass = true;
            }
            _ => {}
        }
    }

    fn observe_reproducer(&mut self, delta: TestDelta) {
        if delta == TestDelta::Fixed {
            self.structural_pass = true;
            self.reproducer_fixed = true;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct CheckpointArtifact<'a> {
    schema_version: u8,
    state: &'a str,
    patch_fingerprint: Option<&'a str>,
    patch_file: &'a str,
    evidence: Option<&'a CheckpointEvidence>,
    detail: &'a str,
}

#[derive(Clone, Debug)]
struct Checkpoint {
    fingerprint: String,
    patch: Vec<u8>,
    evidence: CheckpointEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckpointUpdate {
    Captured { fingerprint: String },
    Retained { fingerprint: String },
    Skipped { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckpointRestore {
    Restored { fingerprint: String },
    AlreadySelected { fingerprint: String },
    NoCheckpoint,
    Skipped { reason: String },
}

pub struct CausalCheckpointStore {
    artifact_dir: Option<PathBuf>,
    current_fingerprint: Option<String>,
    current_evidence: CheckpointEvidence,
    best: Option<Checkpoint>,
}

impl CausalCheckpointStore {
    pub fn from_artifact_dir(artifact_dir: Option<&Path>) -> Self {
        Self {
            artifact_dir: artifact_dir.map(Path::to_path_buf),
            current_fingerprint: None,
            current_evidence: CheckpointEvidence::default(),
            best: None,
        }
    }

    pub fn begin_patch(&mut self, patch_fingerprint: &str) {
        if self.current_fingerprint.as_deref() != Some(patch_fingerprint) {
            self.current_fingerprint = Some(patch_fingerprint.to_string());
            self.current_evidence = CheckpointEvidence::default();
        }
    }

    pub fn has_checkpoint(&self) -> bool {
        self.best.is_some()
    }

    pub fn observe_scope(&mut self, workdir: &str, signal: CausalScopeSignal) -> CheckpointUpdate {
        self.current_evidence.observe_scope(signal);
        self.consider_current(workdir)
    }

    pub fn observe_reproducer(&mut self, workdir: &str, delta: TestDelta) -> CheckpointUpdate {
        self.current_evidence.observe_reproducer(delta);
        self.consider_current(workdir)
    }

    pub fn restore_best_before_final(&mut self, workdir: &str) -> CheckpointRestore {
        self.restore_best(
            workdir,
            "best evidence-backed candidate restored before canonical evaluation",
        )
    }

    pub fn restore_best_for_selection(&mut self, workdir: &str) -> CheckpointRestore {
        self.restore_best(
            workdir,
            "best evidence-backed candidate restored after bounded causal search",
        )
    }

    fn restore_best(&mut self, workdir: &str, restored_detail: &str) -> CheckpointRestore {
        let Some(best) = self.best.clone() else {
            self.write_artifact(
                "no_checkpoint",
                None,
                "no evidence-backed candidate was captured",
            );
            return CheckpointRestore::NoCheckpoint;
        };
        let current = match current_patch(workdir) {
            Ok(current) => current,
            Err(reason) => {
                self.write_artifact("restore_skipped", Some(&best), &reason);
                return CheckpointRestore::Skipped { reason };
            }
        };
        if current.fingerprint == best.fingerprint {
            self.write_artifact(
                "already_selected",
                Some(&best),
                "current diff already matches best checkpoint",
            );
            return CheckpointRestore::AlreadySelected {
                fingerprint: best.fingerprint,
            };
        }
        if let Err(reason) = apply_patch(workdir, &current.patch, true) {
            self.write_artifact("restore_skipped", Some(&best), &reason);
            return CheckpointRestore::Skipped { reason };
        }
        if let Err(reason) = apply_patch(workdir, &best.patch, false) {
            let recovery = apply_patch(workdir, &current.patch, false);
            let detail = match recovery {
                Ok(()) => format!("apply checkpoint failed: {reason}; original diff restored"),
                Err(recovery_error) => format!(
                    "apply checkpoint failed: {reason}; restoring original diff also failed: {recovery_error}"
                ),
            };
            self.write_artifact("restore_failed", Some(&best), &detail);
            return CheckpointRestore::Skipped { reason: detail };
        }
        self.write_artifact("restored", Some(&best), restored_detail);
        CheckpointRestore::Restored {
            fingerprint: best.fingerprint,
        }
    }

    fn consider_current(&mut self, workdir: &str) -> CheckpointUpdate {
        if !self.current_evidence.is_evidence_backed() {
            return CheckpointUpdate::Skipped {
                reason: "no positive typed evidence for current patch".to_string(),
            };
        }
        let current = match current_patch(workdir) {
            Ok(current) => current,
            Err(reason) => {
                self.write_artifact("capture_skipped", None, &reason);
                return CheckpointUpdate::Skipped { reason };
            }
        };
        if current.patch.is_empty() {
            let reason = "no tracked candidate diff to checkpoint".to_string();
            self.write_artifact("capture_skipped", None, &reason);
            return CheckpointUpdate::Skipped { reason };
        }
        if self.current_fingerprint.as_deref() != Some(&current.fingerprint) {
            self.current_fingerprint = Some(current.fingerprint.clone());
            self.current_evidence.changed_lines = current.changed_lines;
        }
        self.current_evidence.changed_lines = current.changed_lines;
        let candidate = Checkpoint {
            fingerprint: current.fingerprint.clone(),
            patch: current.patch,
            evidence: self.current_evidence.clone(),
        };
        if self
            .best
            .as_ref()
            .is_none_or(|best| should_replace(best, &candidate))
        {
            self.best = Some(candidate.clone());
            self.write_artifact(
                "captured",
                Some(&candidate),
                "positive typed evidence improved best checkpoint",
            );
            CheckpointUpdate::Captured {
                fingerprint: candidate.fingerprint,
            }
        } else {
            let best = self.best.as_ref().expect("checked above");
            self.write_artifact(
                "retained",
                Some(best),
                "existing checkpoint has stronger evidence or the candidate did not extend it cumulatively",
            );
            CheckpointUpdate::Retained {
                fingerprint: best.fingerprint.clone(),
            }
        }
    }

    fn write_artifact(&self, state: &str, checkpoint: Option<&Checkpoint>, detail: &str) {
        let Some(directory) = &self.artifact_dir else {
            return;
        };
        if let Err(error) = std::fs::create_dir_all(directory) {
            eprintln!(
                "[CAUSAL_CHECKPOINT] artifact_dir_failed path={} error={}",
                directory.display(),
                error
            );
            return;
        }
        let patch_file = "causal-best-checkpoint.patch";
        if let Some(checkpoint) = checkpoint {
            if let Err(error) = std::fs::write(directory.join(patch_file), &checkpoint.patch) {
                eprintln!(
                    "[CAUSAL_CHECKPOINT] patch_write_failed path={} error={}",
                    directory.join(patch_file).display(),
                    error
                );
            }
        }
        let artifact = CheckpointArtifact {
            schema_version: 1,
            state,
            patch_fingerprint: checkpoint.map(|value| value.fingerprint.as_str()),
            patch_file,
            evidence: checkpoint.map(|value| &value.evidence),
            detail,
        };
        match serde_json::to_string_pretty(&artifact) {
            Ok(encoded) => {
                if let Err(error) = std::fs::write(
                    directory.join("causal-best-checkpoint.json"),
                    format!("{encoded}\n"),
                ) {
                    eprintln!(
                        "[CAUSAL_CHECKPOINT] artifact_write_failed path={} error={}",
                        directory.join("causal-best-checkpoint.json").display(),
                        error
                    );
                }
            }
            Err(error) => eprintln!("[CAUSAL_CHECKPOINT] artifact_encode_failed error={error}"),
        }
    }
}

fn should_replace(best: &Checkpoint, candidate: &Checkpoint) -> bool {
    if candidate.evidence.quality() != best.evidence.quality() {
        return candidate.evidence.quality() > best.evidence.quality();
    }
    patch_strictly_contains(&candidate.patch, &best.patch)
}

fn patch_strictly_contains(candidate: &[u8], retained: &[u8]) -> bool {
    let candidate_atoms = patch_change_atoms(candidate);
    let retained_atoms = patch_change_atoms(retained);
    let candidate_count: usize = candidate_atoms.values().sum();
    let retained_count: usize = retained_atoms.values().sum();
    if retained_atoms.is_empty() || candidate_count <= retained_count {
        return false;
    }
    retained_atoms.iter().all(|(atom, retained_count)| {
        candidate_atoms.get(atom).copied().unwrap_or_default() >= *retained_count
    })
}

fn patch_change_atoms(patch: &[u8]) -> BTreeMap<(String, char, String), usize> {
    let text = String::from_utf8_lossy(patch);
    let mut file = String::new();
    let mut atoms = BTreeMap::new();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("diff --git ") {
            file = header.to_string();
            continue;
        }
        let Some((kind, content)) = line
            .strip_prefix('+')
            .map(|content| ('+', content))
            .or_else(|| line.strip_prefix('-').map(|content| ('-', content)))
        else {
            continue;
        };
        if line.starts_with("+++") || line.starts_with("---") || file.is_empty() {
            continue;
        }
        *atoms
            .entry((file.clone(), kind, content.to_string()))
            .or_insert(0) += 1;
    }
    atoms
}

struct CurrentPatch {
    fingerprint: String,
    patch: Vec<u8>,
    changed_lines: usize,
}

fn current_patch(workdir: &str) -> Result<CurrentPatch, String> {
    let status = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(workdir)
        .output()
        .map_err(|error| format!("read git status: {error}"))?;
    if !status.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    if String::from_utf8_lossy(&status.stdout)
        .lines()
        .any(|line| line.starts_with("??"))
    {
        return Err("untracked files prevent reversible causal checkpoint capture".to_string());
    }
    let diff = Command::new("git")
        .args(["diff", "--binary", "--no-ext-diff"])
        .current_dir(workdir)
        .output()
        .map_err(|error| format!("read git diff: {error}"))?;
    if !diff.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&diff.stderr).trim()
        ));
    }
    let patch = diff.stdout;
    Ok(CurrentPatch {
        fingerprint: stable_hash(&patch),
        changed_lines: patch
            .split(|byte| *byte == b'\n')
            .filter(|line| {
                (line.starts_with(b"+") && !line.starts_with(b"+++"))
                    || (line.starts_with(b"-") && !line.starts_with(b"---"))
            })
            .count(),
        patch,
    })
}

fn apply_patch(workdir: &str, patch: &[u8], reverse: bool) -> Result<(), String> {
    if patch.is_empty() {
        return Ok(());
    }
    let mut command = Command::new("git");
    command.arg("apply").arg("--whitespace=nowarn");
    if reverse {
        command.arg("--reverse");
    }
    command
        .arg("-")
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn git apply: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "git apply stdin unavailable".to_string())?
        .write_all(patch)
        .map_err(|error| format!("write git apply patch: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait git apply: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git apply {}failed: {}",
            if reverse { "reverse " } else { "" },
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn checkpoint(evidence: CheckpointEvidence, changed_lines: usize) -> Checkpoint {
        Checkpoint {
            fingerprint: format!("candidate-{changed_lines}"),
            patch: b"diff --git a/a b/a\n".to_vec(),
            evidence: CheckpointEvidence {
                changed_lines,
                ..evidence
            },
        }
    }

    fn checkpoint_with_patch(evidence: CheckpointEvidence, patch: &str) -> Checkpoint {
        Checkpoint {
            fingerprint: stable_hash(patch.as_bytes()),
            patch: patch.as_bytes().to_vec(),
            evidence: CheckpointEvidence {
                changed_lines: patch.lines().filter(|line| {
                    (line.starts_with('+') && !line.starts_with("+++"))
                        || (line.starts_with('-') && !line.starts_with("---"))
                }).count(),
                ..evidence
            },
        }
    }

    #[test]
    fn stronger_causal_evidence_replaces_weaker_candidate() {
        let structural = checkpoint(
            CheckpointEvidence {
                structural_pass: true,
                ..CheckpointEvidence::default()
            },
            2,
        );
        let reproduced = checkpoint(
            CheckpointEvidence {
                structural_pass: true,
                reproducer_fixed: true,
                regression_pass: true,
                ..CheckpointEvidence::default()
            },
            20,
        );
        assert!(should_replace(&structural, &reproduced));
        assert!(!should_replace(&reproduced, &structural));
    }

    #[test]
    fn equally_evidenced_cumulative_patch_replaces_partial_checkpoint() {
        let evidence = CheckpointEvidence {
            structural_pass: true,
            regression_pass: true,
            ..CheckpointEvidence::default()
        };
        let partial = checkpoint_with_patch(
            evidence.clone(),
            "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n-old_x\n+new_x\n",
        );
        let cumulative = checkpoint_with_patch(
            evidence,
            "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n-old_x\n+new_x\n-old_y\n+new_y\n",
        );
        assert!(should_replace(&partial, &cumulative));
        assert!(!should_replace(&cumulative, &partial));
    }

    #[test]
    fn equally_evidenced_divergent_patch_does_not_displace_stable_checkpoint() {
        let evidence = CheckpointEvidence {
            structural_pass: true,
            ..CheckpointEvidence::default()
        };
        let retained = checkpoint_with_patch(
            evidence.clone(),
            "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n-old_x\n+new_x\n",
        );
        let divergent = checkpoint_with_patch(
            evidence,
            "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n-old_y\n+new_y\n",
        );
        assert!(!should_replace(&retained, &divergent));
        assert!(!should_replace(&divergent, &retained));
    }

    #[test]
    fn scope_and_reproducer_evidence_accumulate_without_declaring_a_solve() {
        let mut evidence = CheckpointEvidence::default();
        evidence.observe_scope(CausalScopeSignal::RegressionPass);
        evidence.observe_reproducer(TestDelta::Fixed);
        assert!(evidence.structural_pass);
        assert!(evidence.regression_pass);
        assert!(evidence.reproducer_fixed);
    }

    #[test]
    fn restore_replaces_a_later_unevidenced_patch_with_the_best_checkpoint() {
        let repo = tempfile::tempdir().unwrap();
        let workdir = repo.path().to_str().unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "statewright-test@example.invalid"],
            vec!["config", "user.name", "Statewright Test"],
        ] {
            let status = Command::new("git")
                .args(args)
                .current_dir(workdir)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let source = repo.path().join("widget.txt");
        std::fs::write(&source, "baseline\n").unwrap();
        let status = Command::new("git")
            .args(["add", "widget.txt"])
            .current_dir(workdir)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args(["commit", "-m", "baseline"])
            .current_dir(workdir)
            .status()
            .unwrap();
        assert!(status.success());

        std::fs::write(&source, "candidate-one\n").unwrap();
        let mut store = CausalCheckpointStore::from_artifact_dir(None);
        store.begin_patch("candidate-one");
        assert!(matches!(
            store.observe_scope(workdir, CausalScopeSignal::StructuralPass),
            CheckpointUpdate::Captured { .. }
        ));

        std::fs::write(&source, "candidate-two\n").unwrap();
        store.begin_patch("candidate-two");
        assert!(matches!(
            store.restore_best_before_final(workdir),
            CheckpointRestore::Restored { .. }
        ));
        assert_eq!(std::fs::read_to_string(source).unwrap(), "candidate-one\n");
    }
}
