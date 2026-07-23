pub const TEST_PLATEAU_SOFT_THRESHOLD: u32 = 2;
pub const TEST_PLATEAU_HARD_THRESHOLD: u32 = 3;
pub const PARSE_RECOVERY_THRESHOLD: u32 = 3;
pub const OVERSIZED_RANGE_THRESHOLD: u32 = 3;

pub fn plateau_hint(consecutive: u32) -> &'static str {
    if consecutive >= TEST_PLATEAU_HARD_THRESHOLD {
        "\n\n[SAME-TEST GUARD] You are seeing the same test failure after repeated edits. The latest candidate patch may have been reverted. Stop editing and diagnose fresh evidence: read the exact failing assertion, inspect the implementation locus, run grep for the symbol, or use diff to review the current patch before the next edit."
    } else if consecutive >= TEST_PLATEAU_SOFT_THRESHOLD {
        "\n\n[SAME-TEST DELTA] This failure signature is repeating. Before changing more code, compare the current diff against the failing assertion and identify what new evidence would make the next edit different."
    } else {
        ""
    }
}

pub fn parse_recovery_message(consecutive: u32) -> String {
    if consecutive >= PARSE_RECOVERY_THRESHOLD {
        format!(
            "PARSE_RECOVERY: Your last {} responses were not executable. Respond with exactly one valid JSON object and no prose, markdown, or code fences. Use one constrained action only: read_file with start_line/end_line, grep, inspect_class, edit_block with exact current text, or insert_between with an exact anchor.",
            consecutive
        )
    } else {
        "Your response was not valid JSON. Respond with ONLY a JSON object: {\"tool_calls\": [{\"name\": \"TOOL\", \"args\": {...}}]}".into()
    }
}

pub fn candidate_range_instruction(path: &str, candidates: &str) -> String {
    if candidates.trim().is_empty() {
        return format!(
            "Read a tight range in {} with start_line/end_line before editing again, then use exact current text for a minimal edit.",
            path
        );
    }
    format!(
        "Choose one current candidate range for {} before editing again. First call read_file on the selected start_line/end_line, then use exact current text for a minimal edit.\n\n{}",
        path, candidates
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plateau_hint_has_soft_and_hard_modes() {
        assert!(plateau_hint(TEST_PLATEAU_SOFT_THRESHOLD - 1).is_empty());
        assert!(plateau_hint(TEST_PLATEAU_SOFT_THRESHOLD).contains("SAME-TEST DELTA"));
        assert!(plateau_hint(TEST_PLATEAU_HARD_THRESHOLD).contains("SAME-TEST GUARD"));
    }

    #[test]
    fn parse_recovery_switches_to_constrained_actions() {
        assert!(parse_recovery_message(1).contains("not valid JSON"));
        assert!(
            parse_recovery_message(PARSE_RECOVERY_THRESHOLD)
                .contains("one constrained action only")
        );
    }

    #[test]
    fn candidate_range_instruction_requires_ranged_read() {
        let msg = candidate_range_instruction("src/lib.py", "Candidate 1: lines 1-4");
        assert!(msg.contains("read_file"));
        assert!(msg.contains("start_line/end_line"));
    }
}
