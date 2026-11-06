//! Origin possession is additional to authentication and exact run ownership.
//! Only its hash enters the durable checkpoint; never tool arguments/results.
use sha2::{Digest, Sha256};

pub(crate) const HEADER: &str = "x-statewright-approval-origin";

pub(crate) fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(crate) fn proof_hash(value: &str) -> Option<String> {
    if !valid_hash(value) {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(b"statewright/approval-origin/v1\0");
    digest.update(value.as_bytes());
    Some(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_is_bounded_and_only_a_domain_separated_hash_is_retained() {
        let proof = "a".repeat(64);
        let hash = proof_hash(&proof).unwrap();
        assert!(valid_hash(&hash));
        assert_ne!(hash, proof);
        assert_ne!(hash, proof_hash(&"b".repeat(64)).unwrap());
        for invalid in ["", "label", &"a".repeat(63), &"a".repeat(65), &"A".repeat(64)] {
            assert!(proof_hash(invalid).is_none());
        }
    }
}
