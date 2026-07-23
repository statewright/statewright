use crate::candidate_evidence::{CandidateEvidence, CandidateEvidenceKind};
use std::time::Duration;

const DEFAULT_STEPS: u32 = 16;
const DEFAULT_TIMEOUT_SECONDS: u64 = 180;

#[derive(Clone, Debug)]
pub struct StrengtheningConfig {
    pub enabled: bool,
    pub steps: u32,
    pub timeout: Duration,
}

impl StrengtheningConfig {
    pub fn from_env() -> Self {
        Self {
            enabled: env_flag("SW_CANDIDATE_STRENGTHENING", true),
            steps: env_u32("SW_CANDIDATE_STRENGTHENING_STEPS", DEFAULT_STEPS, 4, 60),
            timeout: Duration::from_secs(env_u64(
                "SW_CANDIDATE_STRENGTHENING_TIMEOUT_SECONDS",
                DEFAULT_TIMEOUT_SECONDS,
                30,
                900,
            )),
        }
    }
}

pub fn should_attempt(
    config: &StrengtheningConfig,
    evidence: &CandidateEvidence,
    patch: &str,
    remaining: Option<Duration>,
) -> bool {
    config.enabled
        && evidence.kind == CandidateEvidenceKind::ConcreteFail
        && !patch.trim().is_empty()
        && remaining.is_none_or(|remaining| remaining >= Duration::from_secs(15))
}

pub fn repair_task(
    original_task: &str,
    candidate_id: &str,
    actual_locus: &str,
    feedback: &str,
) -> String {
    format!(
        "{original_task}\n\n## Candidate Repair Continuation\n\
Candidate `{candidate_id}` produced a source patch at `{actual_locus}`, but a harness-visible validation scope concretely failed. \
Repair this existing patch in place. Read the failure below, make at most one minimal source correction, rerun the named scope, and stop. \
Do not discard the patch, switch to broad exploration, edit tests, or infer hidden benchmark data.\n\n\
Validation failure:\n```text\n{}\n```\n",
        compact_tail(feedback, 6000)
    )
}

fn compact_tail(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= limit {
        return value.to_string();
    }
    format!(
        "...[earlier output omitted]\n{}",
        chars[chars.len() - limit..].iter().collect::<String>()
    )
}

fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn env_u32(name: &str, default: u32, min: u32, max: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_concrete_failed_patches_receive_continuation() {
        let config = StrengtheningConfig {
            enabled: true,
            steps: 10,
            timeout: Duration::from_secs(60),
        };
        let fail = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] FAIL kind=assertion_failure scope=SOURCE_SCOPE_TEST_FILES=tests/test_x.py\n",
        );
        let unavailable = CandidateEvidence::from_output("[FINAL_VERIFICATION] UNAVAILABLE\n");

        assert!(should_attempt(&config, &fail, "diff --git a/x b/x", None));
        assert!(!should_attempt(
            &config,
            &unavailable,
            "diff --git a/x b/x",
            None
        ));
        assert!(!should_attempt(&config, &fail, "", None));
    }
}
