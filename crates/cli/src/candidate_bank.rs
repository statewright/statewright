use crate::{patch_authority, tools};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

const DEFAULT_MAX_CANDIDATES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CandidateBankMode {
    Sequential,
    BestOfN,
}

impl CandidateBankMode {
    fn from_env() -> Self {
        let value = std::env::var("SW_CANDIDATE_BANK_MODE")
            .ok()
            .or_else(|| std::env::var("SW_PATCH_TOURNAMENT").ok())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        match value.as_str() {
            "1" | "true" | "yes" | "on" | "best_of_n" | "best-of-n" | "bestofn" | "parallel"
            | "fanout" | "tournament" => CandidateBankMode::BestOfN,
            _ => CandidateBankMode::Sequential,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            CandidateBankMode::Sequential => "sequential",
            CandidateBankMode::BestOfN => "best_of_n",
        }
    }
}

#[derive(Clone)]
pub struct CandidateBank {
    enabled: bool,
    max_candidates: usize,
    reanchor_best_path: bool,
    early_stop: bool,
    early_stop_min_score: i32,
    early_stop_fail_count: u32,
    next_id: u32,
    candidates: Vec<CandidatePatch>,
    artifact_dir: Option<PathBuf>,
    mode: CandidateBankMode,
}

#[derive(Clone)]
struct CandidatePatch {
    id: u32,
    score: i32,
    snapshot: tools::Snapshot,
    changed_files: Vec<String>,
    changed_lines: usize,
    failure_signature: String,
    scope_desc: String,
    positive_feedback: bool,
    feedback_only: bool,
    validation_hits: u32,
    patch_path: Option<String>,
    patch_hash: Option<String>,
}

impl CandidatePatch {
    fn has_authoritative_source_patch(&self) -> bool {
        patch_authority::patch_has_authoritative_source(&self.changed_files, self.changed_lines)
    }

    fn restore_allowed_without_early_stop(
        &self,
        _current_changed: &[(String, usize, usize)],
    ) -> bool {
        if !self.has_authoritative_source_patch() || self.feedback_only {
            return false;
        }
        if !self.positive_feedback {
            return false;
        }
        true
    }

    fn final_restore_allowed(&self, _current_changed: &[(String, usize, usize)]) -> bool {
        self.has_authoritative_source_patch() && self.positive_feedback && !self.feedback_only
    }

    fn reanchor_allowed(&self) -> bool {
        self.has_authoritative_source_patch() && self.positive_feedback
    }
}

#[derive(Serialize)]
struct CandidateBankEvent<'a> {
    event: &'a str,
    id: Option<u32>,
    score: Option<i32>,
    changed_files: Option<&'a [String]>,
    changed_lines: Option<usize>,
    scope_desc: Option<&'a str>,
    failure_signature: Option<&'a str>,
    positive_feedback: Option<bool>,
    feedback_only: Option<bool>,
    validation_hits: Option<u32>,
    candidate_count: usize,
    detail: Option<&'a str>,
}

#[derive(Serialize)]
struct CandidateBankEventEnvelope<'a> {
    mode: &'static str,
    #[serde(flatten)]
    event: CandidateBankEvent<'a>,
}

#[derive(Serialize)]
struct CandidateSelectionReport<'a> {
    schema_version: u32,
    artifact: &'static str,
    mode: &'static str,
    test_legal: bool,
    benchmark_clean: bool,
    scoring_boundary: &'static str,
    official_solve_authority: &'static str,
    selection_mechanism: &'static str,
    selected_patch_source: &'static str,
    selected_candidate_id: Option<u32>,
    challenger_candidate_id: Option<u32>,
    current_score: i32,
    current_changed_files: Vec<ChangedFileReport<'a>>,
    current_patch_hash: Option<String>,
    current_patch_error: Option<&'a str>,
    candidate_count: usize,
    retained_candidates: Vec<CandidateReport<'a>>,
    detail: &'a str,
}

#[derive(Serialize)]
struct ChangedFileReport<'a> {
    path: &'a str,
    changed_lines: usize,
    anchor_line: usize,
}

#[derive(Serialize)]
struct CandidateReport<'a> {
    id: u32,
    score: i32,
    changed_files: &'a [String],
    changed_lines: usize,
    scope_desc: &'a str,
    failure_signature: &'a str,
    positive_feedback: bool,
    feedback_only: bool,
    validation_hits: u32,
    patch_path: Option<&'a str>,
    patch_hash: Option<&'a str>,
}

impl CandidateBank {
    pub fn from_env() -> Self {
        let enabled = env_flag("SW_CANDIDATE_BANK", false);
        let mode = CandidateBankMode::from_env();
        let max_candidates = env_usize("SW_CANDIDATE_BANK_MAX", DEFAULT_MAX_CANDIDATES, 1, 12);
        let reanchor_best_path = env_flag("SW_CANDIDATE_BANK_REANCHOR", false);
        let early_stop = env_flag("SW_CANDIDATE_BANK_EARLY_STOP", false);
        let early_stop_min_score = env_i32("SW_CANDIDATE_BANK_EARLY_STOP_MIN_SCORE", 60, -200, 200);
        let early_stop_fail_count = env_u32("SW_CANDIDATE_BANK_EARLY_STOP_FAIL_COUNT", 6, 3, 20);
        let artifact_dir = std::env::var("SW_ARTIFACT_DIR")
            .ok()
            .or_else(|| std::env::var("STATEWRIGHT_ARTIFACT_DIR").ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self {
            enabled,
            max_candidates,
            reanchor_best_path,
            early_stop,
            early_stop_min_score,
            early_stop_fail_count,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir,
            mode,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn reanchor_best_path_enabled(&self) -> bool {
        self.enabled && self.reanchor_best_path
    }

    pub fn early_stop_fail_count(&self) -> u32 {
        self.early_stop_fail_count
    }

    pub fn best_changed_files(&self) -> Vec<String> {
        self.best_candidate_matching(CandidatePatch::reanchor_allowed)
            .map(|candidate| candidate.changed_files.clone())
            .unwrap_or_default()
    }

    pub fn restore_best_for_stagnation(
        &self,
        workdir: &str,
        current_changed: &[(String, usize, usize)],
        reason: &str,
    ) -> bool {
        if !self.enabled || !self.early_stop {
            return false;
        }
        let Some(best) = self.best_candidate_matching(|candidate| {
            candidate.restore_allowed_without_early_stop(current_changed)
        }) else {
            return false;
        };
        if best.score < self.early_stop_min_score {
            self.write_event(CandidateBankEvent {
                event: "early_stop_skipped",
                id: Some(best.id),
                score: Some(best.score),
                changed_files: Some(&best.changed_files),
                changed_lines: Some(best.changed_lines),
                scope_desc: Some(&best.scope_desc),
                failure_signature: Some(&best.failure_signature),
                positive_feedback: Some(best.positive_feedback),
                feedback_only: Some(best.feedback_only),
                validation_hits: Some(best.validation_hits),
                candidate_count: self.candidates.len(),
                detail: Some("best candidate score below early-stop threshold"),
            });
            return false;
        }

        let current_score = score_current_diff(current_changed);
        println!(
            "  [CANDIDATE-BANK] early-stop restore id={} score={} current_score={} reason={} files={}",
            best.id,
            best.score,
            current_score,
            reason,
            best.changed_files.join(",")
        );
        tools::restore_from_snapshot(workdir, &best.snapshot);
        self.write_event(CandidateBankEvent {
            event: "early_stop_restored_best",
            id: Some(best.id),
            score: Some(best.score),
            changed_files: Some(&best.changed_files),
            changed_lines: Some(best.changed_lines),
            scope_desc: Some(&best.scope_desc),
            failure_signature: Some(&best.failure_signature),
            positive_feedback: Some(best.positive_feedback),
            feedback_only: Some(best.feedback_only),
            validation_hits: Some(best.validation_hits),
            candidate_count: self.candidates.len(),
            detail: Some(reason),
        });
        true
    }

    pub fn record_failed_candidate(
        &mut self,
        workdir: &str,
        changed: &[(String, usize, usize)],
        test_output: &str,
        scope_desc: &str,
        same_failure_count: u32,
    ) {
        if !self.enabled || changed.is_empty() {
            return;
        }

        let changed_files: Vec<String> = changed.iter().map(|(path, _, _)| path.clone()).collect();
        let changed_lines: usize = changed.iter().map(|(_, lines, _)| *lines).sum();
        if changed_lines == 0 {
            return;
        }
        if !patch_authority::patch_has_authoritative_source(&changed_files, changed_lines) {
            let rejected = patch_authority::non_authoritative_patch_paths(&changed_files);
            let failure_signature = failure_signature(test_output);
            self.write_event(CandidateBankEvent {
                event: "skipped_non_authoritative_patch",
                id: None,
                score: None,
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(false),
                feedback_only: Some(false),
                validation_hits: Some(0),
                candidate_count: self.candidates.len(),
                detail: Some(if rejected.is_empty() {
                    "patch had no authoritative source changes"
                } else {
                    "patch touched generated, build, cache, or test paths"
                }),
            });
            return;
        }

        if invalid_test_scope_signal(test_output) {
            let failure_signature = failure_signature(test_output);
            self.write_event(CandidateBankEvent {
                event: "skipped_invalid_scope",
                id: None,
                score: None,
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(false),
                feedback_only: Some(false),
                validation_hits: Some(0),
                candidate_count: self.candidates.len(),
                detail: Some("test feedback was a collection/scope failure"),
            });
            return;
        }

        let failure_signature = failure_signature(test_output);
        let score = score_candidate(changed, test_output, same_failure_count);
        if self.candidates.iter().any(|candidate| {
            candidate.changed_files == changed_files
                && candidate.failure_signature == failure_signature
        }) {
            self.write_event(CandidateBankEvent {
                event: "duplicate",
                id: None,
                score: Some(score),
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(false),
                feedback_only: Some(false),
                validation_hits: Some(0),
                candidate_count: self.candidates.len(),
                detail: Some("same changed files and failure signature already retained"),
            });
            return;
        }

        let id = self.next_id;
        let (patch_path, patch_hash) = self.capture_candidate_patch(id, workdir);
        let candidate = CandidatePatch {
            id,
            score,
            snapshot: tools::snapshot_all(workdir),
            changed_files,
            changed_lines,
            failure_signature,
            scope_desc: scope_desc.to_string(),
            positive_feedback: false,
            feedback_only: false,
            validation_hits: 0,
            patch_path,
            patch_hash,
        };
        self.next_id = self.next_id.saturating_add(1);
        println!(
            "  [CANDIDATE-BANK] recorded id={} score={} files={} lines={} scope={}",
            candidate.id,
            candidate.score,
            candidate.changed_files.join(","),
            candidate.changed_lines,
            candidate.scope_desc
        );
        self.write_event(CandidateBankEvent {
            event: "recorded",
            id: Some(candidate.id),
            score: Some(candidate.score),
            changed_files: Some(&candidate.changed_files),
            changed_lines: Some(candidate.changed_lines),
            scope_desc: Some(&candidate.scope_desc),
            failure_signature: Some(&candidate.failure_signature),
            positive_feedback: Some(candidate.positive_feedback),
            feedback_only: Some(candidate.feedback_only),
            validation_hits: Some(candidate.validation_hits),
            candidate_count: self.candidates.len() + 1,
            detail: None,
        });
        self.candidates.push(candidate);
        self.prune();
    }

    pub fn record_feedback_pass_candidate(
        &mut self,
        workdir: &str,
        changed: &[(String, usize, usize)],
        test_output: &str,
        scope_desc: &str,
        feedback_only: bool,
    ) {
        if !self.enabled || changed.is_empty() {
            return;
        }

        let changed_files: Vec<String> = changed.iter().map(|(path, _, _)| path.clone()).collect();
        let changed_lines: usize = changed.iter().map(|(_, lines, _)| *lines).sum();
        if changed_lines == 0 {
            return;
        }
        if !patch_authority::patch_has_authoritative_source(&changed_files, changed_lines) {
            let rejected = patch_authority::non_authoritative_patch_paths(&changed_files);
            let failure_signature = failure_signature(test_output);
            self.write_event(CandidateBankEvent {
                event: "skipped_non_authoritative_feedback_pass",
                id: None,
                score: None,
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(true),
                feedback_only: Some(feedback_only),
                validation_hits: Some(0),
                candidate_count: self.candidates.len(),
                detail: Some(if rejected.is_empty() {
                    "feedback-pass patch had no authoritative source changes"
                } else {
                    "feedback-pass patch touched generated, build, cache, or test paths"
                }),
            });
            return;
        }

        if feedback_only && invalid_test_scope_signal(test_output) {
            let failure_signature = failure_signature(test_output);
            self.write_event(CandidateBankEvent {
                event: "skipped_invalid_feedback_pass_scope",
                id: None,
                score: None,
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(true),
                feedback_only: Some(true),
                validation_hits: Some(0),
                candidate_count: self.candidates.len(),
                detail: Some("feedback-only pass came from an invalid harness scope"),
            });
            return;
        }

        let score = score_feedback_pass_candidate(changed, feedback_only, 1);
        let failure_signature = format!(
            "pass:{}:{}",
            if feedback_only { "feedback" } else { "trusted" },
            failure_signature(test_output)
        );
        if self.candidates.iter().any(|candidate| {
            candidate.positive_feedback
                && candidate.changed_files == changed_files
                && candidate.scope_desc == scope_desc
        }) {
            self.write_event(CandidateBankEvent {
                event: "duplicate_feedback_pass",
                id: None,
                score: Some(score),
                changed_files: Some(&changed_files),
                changed_lines: Some(changed_lines),
                scope_desc: Some(scope_desc),
                failure_signature: Some(&failure_signature),
                positive_feedback: Some(true),
                feedback_only: Some(feedback_only),
                validation_hits: Some(1),
                candidate_count: self.candidates.len(),
                detail: Some("same feedback-pass changed files and scope already retained; confidence not boosted"),
            });
            return;
        }

        if feedback_only {
            if let Some(index) = self.candidates.iter().position(|candidate| {
                candidate.positive_feedback
                    && candidate.feedback_only
                    && candidate.changed_files == changed_files
                    && candidate.scope_desc != scope_desc
            }) {
                let (
                    id,
                    score,
                    changed_files,
                    changed_lines,
                    scope_desc,
                    failure_signature,
                    validation_hits,
                ) = {
                    let candidate = &mut self.candidates[index];
                    candidate.validation_hits = candidate.validation_hits.saturating_add(1);
                    candidate.score =
                        score_feedback_pass_candidate(changed, true, candidate.validation_hits);
                    candidate.failure_signature = failure_signature.clone();
                    (
                        candidate.id,
                        candidate.score,
                        candidate.changed_files.clone(),
                        candidate.changed_lines,
                        candidate.scope_desc.clone(),
                        candidate.failure_signature.clone(),
                        candidate.validation_hits,
                    )
                };
                println!(
                    "  [CANDIDATE-BANK] corroborated feedback-pass id={} score={} hits={} files={} scope={}",
                    id,
                    score,
                    validation_hits,
                    changed_files.join(","),
                    scope_desc
                );
                self.write_event(CandidateBankEvent {
                    event: "corroborated_feedback_pass",
                    id: Some(id),
                    score: Some(score),
                    changed_files: Some(&changed_files),
                    changed_lines: Some(changed_lines),
                    scope_desc: Some(&scope_desc),
                    failure_signature: Some(&failure_signature),
                    positive_feedback: Some(true),
                    feedback_only: Some(true),
                    validation_hits: Some(validation_hits),
                    candidate_count: self.candidates.len(),
                    detail: Some("feedback-only pass corroborated by a distinct validation scope"),
                });
                self.prune();
                return;
            }
        }

        let id = self.next_id;
        let (patch_path, patch_hash) = self.capture_candidate_patch(id, workdir);
        let candidate = CandidatePatch {
            id,
            score,
            snapshot: tools::snapshot_all(workdir),
            changed_files,
            changed_lines,
            failure_signature,
            scope_desc: scope_desc.to_string(),
            positive_feedback: true,
            feedback_only,
            validation_hits: 1,
            patch_path,
            patch_hash,
        };
        self.next_id = self.next_id.saturating_add(1);
        println!(
            "  [CANDIDATE-BANK] recorded feedback-pass id={} score={} files={} lines={} scope={} feedback_only={}",
            candidate.id,
            candidate.score,
            candidate.changed_files.join(","),
            candidate.changed_lines,
            candidate.scope_desc,
            feedback_only
        );
        self.write_event(CandidateBankEvent {
            event: "recorded_feedback_pass",
            id: Some(candidate.id),
            score: Some(candidate.score),
            changed_files: Some(&candidate.changed_files),
            changed_lines: Some(candidate.changed_lines),
            scope_desc: Some(&candidate.scope_desc),
            failure_signature: Some(&candidate.failure_signature),
            positive_feedback: Some(candidate.positive_feedback),
            feedback_only: Some(candidate.feedback_only),
            validation_hits: Some(candidate.validation_hits),
            candidate_count: self.candidates.len() + 1,
            detail: Some(if feedback_only {
                "single-scope feedback-only pass retained as a low-confidence positive candidate, not as proof of completion"
            } else {
                "trusted scoped pass retained as a positive candidate"
            }),
        });
        self.candidates.push(candidate);
        self.prune();
    }

    pub fn restore_best_before_final(
        &self,
        workdir: &str,
        current_changed: &[(String, usize, usize)],
    ) -> bool {
        if !self.enabled || self.candidates.is_empty() {
            return false;
        }
        let current_score = score_current_diff(current_changed);
        let Some(best) = self.best_candidate_for_final_restore(current_changed) else {
            self.write_selection_report(
                workdir,
                None,
                None,
                current_changed,
                current_score,
                "no final-restorable candidate passed candidate-bank confidence gates",
            );
            return false;
        };
        let materially_worse = best.score.saturating_sub(current_score) >= 20;
        if current_changed.is_empty() || materially_worse {
            self.write_selection_report(
                workdir,
                Some(best),
                Some(best),
                current_changed,
                current_score,
                "best retained candidate outranked current final diff",
            );
            println!(
                "  [CANDIDATE-BANK] restoring best id={} score={} current_score={} files={}",
                best.id,
                best.score,
                current_score,
                best.changed_files.join(",")
            );
            tools::restore_from_snapshot(workdir, &best.snapshot);
            self.write_event(CandidateBankEvent {
                event: "restored_best",
                id: Some(best.id),
                score: Some(best.score),
                changed_files: Some(&best.changed_files),
                changed_lines: Some(best.changed_lines),
                scope_desc: Some(&best.scope_desc),
                failure_signature: Some(&best.failure_signature),
                positive_feedback: Some(best.positive_feedback),
                feedback_only: Some(best.feedback_only),
                validation_hits: Some(best.validation_hits),
                candidate_count: self.candidates.len(),
                detail: Some("best retained candidate outranked current final diff"),
            });
            return true;
        }
        self.write_selection_report(
            workdir,
            None,
            Some(best),
            current_changed,
            current_score,
            "current final diff was not worse than retained best candidate",
        );
        self.write_event(CandidateBankEvent {
            event: "kept_current",
            id: Some(best.id),
            score: Some(best.score),
            changed_files: Some(&best.changed_files),
            changed_lines: Some(best.changed_lines),
            scope_desc: Some(&best.scope_desc),
            failure_signature: Some(&best.failure_signature),
            positive_feedback: Some(best.positive_feedback),
            feedback_only: Some(best.feedback_only),
            validation_hits: Some(best.validation_hits),
            candidate_count: self.candidates.len(),
            detail: Some("current final diff was not worse than retained best candidate"),
        });
        false
    }

    pub fn feedback_only_branch_can_discard_current(
        &self,
        current_changed: &[(String, usize, usize)],
    ) -> bool {
        self.best_candidate_for_final_restore(current_changed)
            .map(|candidate| candidate.positive_feedback && candidate.feedback_only)
            .unwrap_or(false)
    }

    fn best_candidate(&self) -> Option<&CandidatePatch> {
        self.best_candidate_matching(|_| true)
    }

    fn best_candidate_matching(
        &self,
        predicate: impl Fn(&CandidatePatch) -> bool,
    ) -> Option<&CandidatePatch> {
        self.candidates
            .iter()
            .filter(|candidate| predicate(candidate))
            .max_by(|left, right| {
                left.score
                    .cmp(&right.score)
                    .then_with(|| right.changed_lines.cmp(&left.changed_lines))
            })
    }

    fn best_candidate_for_final_restore(
        &self,
        current_changed: &[(String, usize, usize)],
    ) -> Option<&CandidatePatch> {
        self.candidates
            .iter()
            .filter(|candidate| candidate.final_restore_allowed(current_changed))
            .max_by(|left, right| {
                left.score
                    .cmp(&right.score)
                    .then_with(|| left.validation_hits.cmp(&right.validation_hits))
                    .then_with(|| right.changed_lines.cmp(&left.changed_lines))
            })
    }

    fn write_selection_report(
        &self,
        workdir: &str,
        selected: Option<&CandidatePatch>,
        challenger: Option<&CandidatePatch>,
        current_changed: &[(String, usize, usize)],
        current_score: i32,
        detail: &str,
    ) {
        let Some(dir) = &self.artifact_dir else {
            return;
        };
        let mut current_patch_error: Option<String> = None;
        let current_patch = match current_git_diff(workdir) {
            Ok(patch) => patch,
            Err(err) => {
                current_patch_error = Some(format!("current git diff unavailable: {err}"));
                if let Some(detail) = current_patch_error.as_deref() {
                    eprintln!("  [CANDIDATE-BANK] {detail}");
                    self.write_event(CandidateBankEvent {
                        event: "current_patch_unavailable",
                        id: None,
                        score: None,
                        changed_files: None,
                        changed_lines: None,
                        scope_desc: None,
                        failure_signature: None,
                        positive_feedback: None,
                        feedback_only: None,
                        validation_hits: None,
                        candidate_count: self.candidates.len(),
                        detail: Some(detail),
                    });
                }
                String::new()
            }
        };
        let current_patch_hash = if current_patch.trim().is_empty() {
            None
        } else {
            Some(stable_patch_hash(&current_patch))
        };
        let report = CandidateSelectionReport {
            schema_version: 1,
            artifact: "statewright.candidate_bank.selection",
            mode: self.mode.as_str(),
            test_legal: true,
            benchmark_clean: true,
            scoring_boundary: "Generated candidate patches and harness-visible validation telemetry only; no official solution patch, hidden test patch, or post-hoc verifier result is exposed to the model.",
            official_solve_authority: "The final official SWE-bench verifier is the sole benchmark solve authority.",
            selection_mechanism: "Retain generated diffs with bounded harness feedback, rank by confidence/size/repetition signals, and restore a retained candidate only when the current final diff is empty or materially worse.",
            selected_patch_source: if selected.is_some() {
                "candidate_bank"
            } else {
                "current_diff"
            },
            selected_candidate_id: selected.map(|candidate| candidate.id),
            challenger_candidate_id: challenger.map(|candidate| candidate.id),
            current_score,
            current_changed_files: current_changed
                .iter()
                .map(|(path, changed_lines, anchor_line)| ChangedFileReport {
                    path: path.as_str(),
                    changed_lines: *changed_lines,
                    anchor_line: *anchor_line,
                })
                .collect(),
            current_patch_hash,
            current_patch_error: current_patch_error.as_deref(),
            candidate_count: self.candidates.len(),
            retained_candidates: self
                .candidates
                .iter()
                .map(|candidate| CandidateReport {
                    id: candidate.id,
                    score: candidate.score,
                    changed_files: &candidate.changed_files,
                    changed_lines: candidate.changed_lines,
                    scope_desc: &candidate.scope_desc,
                    failure_signature: &candidate.failure_signature,
                    positive_feedback: candidate.positive_feedback,
                    feedback_only: candidate.feedback_only,
                    validation_hits: candidate.validation_hits,
                    patch_path: candidate.patch_path.as_deref(),
                    patch_hash: candidate.patch_hash.as_deref(),
                })
                .collect(),
            detail,
        };
        if let Err(err) = std::fs::create_dir_all(dir) {
            eprintln!(
                "  [CANDIDATE-BANK] selection report mkdir failed path={} error={}",
                dir.display(),
                err
            );
            return;
        }
        let path = dir.join("candidate-selection.json");
        let data = match serde_json::to_string_pretty(&report) {
            Ok(data) => data,
            Err(err) => {
                eprintln!("  [CANDIDATE-BANK] selection report serialize failed: {err}");
                return;
            }
        };
        if let Err(err) = std::fs::write(&path, data) {
            eprintln!(
                "  [CANDIDATE-BANK] selection report write failed path={} error={}",
                path.display(),
                err
            );
        }
    }

    fn capture_candidate_patch(&self, id: u32, workdir: &str) -> (Option<String>, Option<String>) {
        let patch = match current_git_diff(workdir) {
            Ok(patch) => patch,
            Err(err) => {
                let detail = format!("candidate patch diff unavailable: {err}");
                eprintln!("  [CANDIDATE-BANK] {detail}");
                self.write_event(CandidateBankEvent {
                    event: "candidate_patch_unavailable",
                    id: Some(id),
                    score: None,
                    changed_files: None,
                    changed_lines: None,
                    scope_desc: None,
                    failure_signature: None,
                    positive_feedback: None,
                    feedback_only: None,
                    validation_hits: None,
                    candidate_count: self.candidates.len(),
                    detail: Some(&detail),
                });
                return (None, None);
            }
        };
        if patch.trim().is_empty() {
            return (None, None);
        }
        let hash = stable_patch_hash(&patch);
        let path = self.write_candidate_patch_artifact(id, &patch);
        (path, Some(hash))
    }

    fn write_candidate_patch_artifact(&self, id: u32, patch: &str) -> Option<String> {
        let dir = self.artifact_dir.as_ref()?;
        let relative = format!("candidate-bank/candidate-{id:04}.patch");
        let path = dir.join(&relative);
        let Some(parent) = path.parent() else {
            eprintln!(
                "  [CANDIDATE-BANK] candidate patch path has no parent path={}",
                path.display()
            );
            return None;
        };
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!(
                "  [CANDIDATE-BANK] candidate patch mkdir failed path={} error={}",
                parent.display(),
                err
            );
            return None;
        }
        if let Err(err) = std::fs::write(&path, patch) {
            eprintln!(
                "  [CANDIDATE-BANK] candidate patch write failed path={} error={}",
                path.display(),
                err
            );
            return None;
        }
        Some(relative)
    }

    fn prune(&mut self) {
        self.candidates.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.changed_lines.cmp(&right.changed_lines))
        });
        while self.candidates.len() > self.max_candidates {
            if let Some(dropped) = self.candidates.pop() {
                println!(
                    "  [CANDIDATE-BANK] dropped id={} score={} files={}",
                    dropped.id,
                    dropped.score,
                    dropped.changed_files.join(",")
                );
                self.write_event(CandidateBankEvent {
                    event: "dropped",
                    id: Some(dropped.id),
                    score: Some(dropped.score),
                    changed_files: Some(&dropped.changed_files),
                    changed_lines: Some(dropped.changed_lines),
                    scope_desc: Some(&dropped.scope_desc),
                    failure_signature: Some(&dropped.failure_signature),
                    positive_feedback: Some(dropped.positive_feedback),
                    feedback_only: Some(dropped.feedback_only),
                    validation_hits: Some(dropped.validation_hits),
                    candidate_count: self.candidates.len(),
                    detail: Some("candidate bank capacity exceeded"),
                });
            }
        }
    }

    fn write_event(&self, event: CandidateBankEvent<'_>) {
        let Some(dir) = &self.artifact_dir else {
            return;
        };
        if let Err(err) = std::fs::create_dir_all(dir) {
            eprintln!(
                "  [CANDIDATE-BANK] event mkdir failed path={} error={}",
                dir.display(),
                err
            );
            return;
        }
        let path = dir.join("candidate-bank.jsonl");
        let mut file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            Ok(file) => file,
            Err(err) => {
                eprintln!("  [CANDIDATE-BANK] event open failed: {err}");
                return;
            }
        };
        let envelope = CandidateBankEventEnvelope {
            mode: self.mode.as_str(),
            event,
        };
        let line = match serde_json::to_string(&envelope) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("  [CANDIDATE-BANK] event serialize failed: {err}");
                return;
            }
        };
        use std::io::Write;
        if let Err(err) = writeln!(file, "{}", line) {
            eprintln!("  [CANDIDATE-BANK] event write failed: {err}");
        }
    }
}

fn current_git_diff(workdir: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args([
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-ext-diff",
            "--binary",
        ])
        .current_dir(workdir)
        .output()
        .map_err(|err| format!("spawn git diff: {err}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git diff exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn stable_patch_hash(patch: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in patch.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on" | "bank" | "candidate"
            )
        })
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn env_u32(name: &str, default: u32, min: u32, max: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn env_i32(name: &str, default: i32, min: i32, max: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn score_candidate(
    changed: &[(String, usize, usize)],
    test_output: &str,
    same_failure_count: u32,
) -> i32 {
    let changed_lines: usize = changed.iter().map(|(_, lines, _)| *lines).sum();
    let changed_files = changed.len();
    let mut score = 100;
    score -= changed_files.saturating_sub(1) as i32 * 8;
    score -= changed_lines.saturating_sub(4) as i32;
    score -= same_failure_count.saturating_sub(1) as i32 * 6;

    let lower = test_output.to_ascii_lowercase();
    if lower.contains("syntaxerror")
        || lower.contains("indentationerror")
        || lower.contains("parse")
    {
        score -= 35;
    }
    if invalid_test_scope_signal(test_output) {
        score -= 50;
    }
    if lower.contains("modulenotfounderror") || lower.contains("importerror") {
        score -= 18;
    }
    if lower.contains("sw_test_exit_code=5")
        || lower.contains("no tests ran")
        || lower.contains("collected 0 items")
    {
        score -= 20;
    }
    score
}

fn score_feedback_pass_candidate(
    changed: &[(String, usize, usize)],
    feedback_only: bool,
    validation_hits: u32,
) -> i32 {
    let changed_lines: usize = changed.iter().map(|(_, lines, _)| *lines).sum();
    let changed_files = changed.len();
    let mut score = if feedback_only { 45 } else { 140 };
    if feedback_only {
        score += validation_hits.saturating_sub(1).min(3) as i32 * 8;
    }
    score -= changed_files.saturating_sub(1) as i32 * 10;
    score -= changed_lines.saturating_sub(8) as i32;
    score
}

fn invalid_test_scope_signal(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("one of the test labels is a path to a file")
        || lower.contains("use a dotted module name or path to a directory instead")
        || lower.contains("sw_test_exit_code=5")
        || lower.contains("no tests ran")
        || lower.contains("no tests collected")
        || lower.contains("collected 0 items")
        || lower.contains("importerror while loading conftest")
        || lower.contains("astropy.logger.loggingerror")
        || lower.contains("cannot disable warnings logging")
        || lower.contains("could not determine astropy package version")
}

fn score_current_diff(changed: &[(String, usize, usize)]) -> i32 {
    if changed.is_empty() {
        return i32::MIN / 2;
    }
    let changed_lines: usize = changed.iter().map(|(_, lines, _)| *lines).sum();
    let mut score = 100;
    score -= changed.len().saturating_sub(1) as i32 * 8;
    score -= changed_lines.saturating_sub(4) as i32;
    score
}

fn failure_signature(output: &str) -> String {
    let mut lines: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("failed")
                || lower.contains("error")
                || lower.contains("assert")
                || lower.contains("traceback")
                || lower.contains("sw_test_exit_code")
        })
        .take(8)
        .map(|line| line.chars().take(180).collect())
        .collect();
    if lines.is_empty() {
        lines.push(
            output
                .lines()
                .next()
                .unwrap_or("unknown failure")
                .chars()
                .take(180)
                .collect(),
        );
    }
    lines.join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_penalizes_structural_failures() {
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let ordinary = score_candidate(&changed, "1 failed, 2 passed", 1);
        let syntax = score_candidate(&changed, "SyntaxError: invalid syntax", 1);
        assert!(ordinary > syntax);
    }

    #[test]
    fn score_penalizes_invalid_scope_feedback() {
        let changed = vec![("django/db/models/fields/files.py".to_string(), 2, 100)];
        let ordinary = score_candidate(&changed, "1 failed, 2 passed", 1);
        let invalid = score_candidate(
            &changed,
            "RuntimeError: One of the test labels is a path to a file: 'tests/model_fields/test_imagefield.py', which is not supported.",
            1,
        );
        assert!(ordinary > invalid);
    }

    #[test]
    fn candidate_bank_skips_invalid_scope_feedback() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("django/db/models/fields/files.py".to_string(), 2, 100)];

        bank.record_failed_candidate(
            ".",
            &changed,
            "SW_TEST_EXIT_CODE=1\nRuntimeError: One of the test labels is a path to a file: 'tests/model_fields/test_imagefield.py', which is not supported.",
            "EDITED_SOURCE_TEST_FILES=tests/model_fields/test_imagefield.py",
            1,
        );

        assert!(bank.candidates.is_empty());
    }

    #[test]
    fn candidate_bank_skips_astropy_conftest_logging_feedback() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("astropy/modeling/separable.py".to_string(), 4, 400)];

        bank.record_failed_candidate(
            ".",
            &changed,
            "SW_TEST_EXIT_CODE=4\nImportError while loading conftest '/testbed/conftest.py'.\nE   astropy.logger.LoggingError: Cannot disable warnings logging: warnings.showwarning was not set by this logger, or has been overridden",
            "EDITED_SOURCE_TEST_FILES=astropy/modeling/tests/test_separable.py",
            1,
        );

        assert!(bank.candidates.is_empty());
    }

    #[test]
    fn candidate_bank_skips_generated_build_patch_paths() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("build/lib/django/core/validators.py".to_string(), 2, 100)];

        bank.record_feedback_pass_candidate(".", &changed, "1 passed", "SOURCE_SCOPE", false);
        bank.record_failed_candidate(".", &changed, "1 failed", "SOURCE_SCOPE", 1);

        assert!(bank.candidates.is_empty());
    }

    #[test]
    fn single_scope_feedback_pass_scores_below_failed_candidate() {
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let failed_score = score_candidate(&changed, "1 failed, 2 passed", 1);
        let feedback_score = score_feedback_pass_candidate(&changed, true, 1);

        assert!(feedback_score < failed_score);
    }

    #[test]
    fn corroborated_feedback_pass_scores_below_failed_candidate() {
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let failed_score = score_candidate(&changed, "1 failed, 2 passed", 1);
        let feedback_score = score_feedback_pass_candidate(&changed, true, 2);

        assert!(feedback_score < failed_score);
    }

    #[test]
    fn candidate_bank_records_feedback_pass_candidate() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");

        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE",
            true,
        );

        assert_eq!(bank.candidates.len(), 1);
        assert!(bank.candidates[0].positive_feedback);
        assert!(bank.candidates[0].feedback_only);
        assert_eq!(bank.candidates[0].validation_hits, 1);
        assert!(bank.candidates[0].score < score_candidate(&changed, "1 failed", 1));
        assert_eq!(bank.best_changed_files(), vec!["pkg/mod.py"]);
        assert!(bank.best_candidate_for_final_restore(&[]).is_none());
    }

    #[test]
    fn candidate_bank_corroborates_distinct_feedback_scope() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");

        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE_A",
            true,
        );
        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE_B",
            true,
        );

        assert_eq!(bank.candidates.len(), 1);
        assert_eq!(bank.candidates[0].validation_hits, 2);
        assert!(bank.candidates[0].score < score_candidate(&changed, "1 failed", 1));
    }

    #[test]
    fn weak_feedback_pass_does_not_restore_over_current_diff() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");

        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE",
            true,
        );

        assert!(!bank.restore_best_before_final(dir.path().to_str().expect("path"), &changed));
    }

    #[test]
    fn feedback_only_pass_cannot_trigger_branch_discard_by_default() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");

        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE",
            true,
        );

        assert!(!bank.feedback_only_branch_can_discard_current(&changed));
    }

    #[test]
    fn feedback_only_pass_does_not_restore_empty_current_diff() {
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::Sequential,
        };
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");

        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 passed",
            "FEEDBACK_SCOPE",
            true,
        );

        assert!(!bank.restore_best_before_final(dir.path().to_str().expect("path"), &[]));
    }

    #[test]
    fn current_empty_diff_scores_as_worse_than_any_candidate() {
        assert!(score_current_diff(&[]) < -1_000_000);
    }

    #[test]
    fn candidate_bank_mode_accepts_best_of_n_and_parallel_aliases() {
        unsafe {
            std::env::set_var("SW_CANDIDATE_BANK_MODE", "parallel");
        }
        assert_eq!(CandidateBankMode::from_env(), CandidateBankMode::BestOfN);
        unsafe {
            std::env::set_var("SW_CANDIDATE_BANK_MODE", "sequential");
        }
        assert_eq!(CandidateBankMode::from_env(), CandidateBankMode::Sequential);
        unsafe {
            std::env::remove_var("SW_CANDIDATE_BANK_MODE");
        }
    }

    #[test]
    fn candidate_bank_writes_patch_and_selection_artifacts() {
        let repo = tempfile::tempdir().expect("tempdir");
        let artifacts = tempfile::tempdir().expect("artifacts");
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(repo.path())
            .output()
            .expect("git init");
        std::fs::create_dir_all(repo.path().join("pkg")).expect("mkdir");
        std::fs::write(repo.path().join("pkg/mod.py"), "value = 1\n").expect("write");
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(repo.path())
            .output()
            .expect("git add");
        std::process::Command::new("git")
            .args([
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=T",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(repo.path())
            .output()
            .expect("git commit");
        std::fs::write(repo.path().join("pkg/mod.py"), "value = 2\n").expect("write changed");

        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: Some(artifacts.path().to_path_buf()),
            mode: CandidateBankMode::BestOfN,
        };
        let changed = vec![("pkg/mod.py".to_string(), 1, 1)];

        bank.record_failed_candidate(
            repo.path().to_str().expect("path"),
            &changed,
            "1 failed, 1 passed",
            "SCOPED_TEST",
            1,
        );
        assert_eq!(bank.candidates.len(), 1);
        assert!(bank.candidates[0].patch_path.is_some());
        assert!(bank.candidates[0].patch_hash.is_some());

        assert!(!bank.restore_best_before_final(repo.path().to_str().expect("path"), &changed));
        let patch_path = artifacts
            .path()
            .join(bank.candidates[0].patch_path.as_ref().expect("patch path"));
        assert!(patch_path.exists());
        let report: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(artifacts.path().join("candidate-selection.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report["artifact"], "statewright.candidate_bank.selection");
        assert_eq!(report["mode"], "best_of_n");
        assert_eq!(report["test_legal"], true);
        assert_eq!(report["benchmark_clean"], true);
        assert!(
            report["scoring_boundary"]
                .as_str()
                .unwrap()
                .contains("no official solution patch")
        );
        assert!(
            report["official_solve_authority"]
                .as_str()
                .unwrap()
                .contains("official SWE-bench verifier")
        );
    }

    #[test]
    fn selection_report_records_current_diff_error() {
        let repo = tempfile::tempdir().expect("tempdir");
        let artifacts = tempfile::tempdir().expect("artifacts");
        let bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: false,
            early_stop: false,
            early_stop_min_score: 60,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: Some(artifacts.path().to_path_buf()),
            mode: CandidateBankMode::BestOfN,
        };

        bank.write_selection_report(
            repo.path().to_str().expect("path"),
            None,
            None,
            &[],
            0,
            "test",
        );

        let report: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(artifacts.path().join("candidate-selection.json")).unwrap(),
        )
        .unwrap();
        assert!(
            report["current_patch_error"]
                .as_str()
                .unwrap()
                .contains("git diff"),
            "{}",
            report
        );
        let events =
            std::fs::read_to_string(artifacts.path().join("candidate-bank.jsonl")).expect("events");
        assert!(events.contains("current_patch_unavailable"), "{}", events);
    }

    #[test]
    fn current_simple_diff_is_not_materially_worse_than_failed_candidate() {
        let changed = vec![("pkg/mod.py".to_string(), 3, 100)];
        let failed_score = score_candidate(&changed, "1 failed, 2 passed", 1);
        let current_score = score_current_diff(&changed);
        assert!(failed_score.saturating_sub(current_score) < 20);
    }

    #[test]
    fn failed_candidate_cannot_restore_or_reanchor_even_with_early_stop() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/mod.py"), "value = 1\n").expect("write");
        let changed = vec![("pkg/mod.py".to_string(), 1, 1)];
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: true,
            early_stop: true,
            early_stop_min_score: -200,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::BestOfN,
        };

        bank.record_failed_candidate(
            dir.path().to_str().expect("path"),
            &changed,
            "1 failed, 2 passed",
            "SOURCE_SCOPE",
            1,
        );

        assert_eq!(bank.candidates.len(), 1);
        assert!(bank.best_changed_files().is_empty());
        assert!(bank.best_candidate_for_final_restore(&[]).is_none());
        assert!(!bank.restore_best_for_stagnation(dir.path().to_str().expect("path"), &[], "test"));
    }

    #[test]
    fn positive_candidate_wins_restore_gate_over_higher_scoring_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pkg")).expect("mkdir");
        std::fs::write(dir.path().join("pkg/failed.py"), "value = 1\n").expect("write");
        std::fs::write(dir.path().join("pkg/passing.py"), "value = 2\n").expect("write");
        let failed = vec![("pkg/failed.py".to_string(), 1, 1)];
        let passing = vec![("pkg/passing.py".to_string(), 80, 1)];
        let mut bank = CandidateBank {
            enabled: true,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            reanchor_best_path: true,
            early_stop: true,
            early_stop_min_score: -200,
            early_stop_fail_count: 6,
            next_id: 1,
            candidates: Vec::new(),
            artifact_dir: None,
            mode: CandidateBankMode::BestOfN,
        };

        bank.record_failed_candidate(
            dir.path().to_str().expect("path"),
            &failed,
            "1 failed, 2 passed",
            "FAILED_SCOPE",
            1,
        );
        bank.record_feedback_pass_candidate(
            dir.path().to_str().expect("path"),
            &passing,
            "3 passed",
            "PASSING_SCOPE",
            false,
        );

        assert!(bank.candidates[0].score > bank.candidates[1].score);
        assert_eq!(bank.best_candidate().expect("numeric best").id, 1);
        assert_eq!(
            bank.best_candidate_for_final_restore(&[])
                .expect("restorable best")
                .id,
            2
        );
        assert_eq!(bank.best_changed_files(), vec!["pkg/passing.py"]);
    }
}
