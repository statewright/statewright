//! Reusable utility behavior contracts, separate from the AST/policy core.
//! These are effect ceilings, not executable allowlists or permission grants.
//! Argument-insensitive contracts cover all utility options, including unknown
//! option spellings: an invalid option may fail, but cannot gain a new effect.
//! Delegating/configurable interpreters and destructive utilities are excluded.
use crate::resource_effects::{READ, WRITE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ceiling {
    pub upper: u8,
    pub contract: &'static str,
}

/// Only bare standard utility identities qualify, matching the existing native
/// utility-trust posture. No basename equivalence for repository executables,
/// execution wrappers, environment assignments or plugin/alias bodies.
pub(crate) fn invariant_ceiling(executable: &str) -> Option<Ceiling> {
    let (upper, contract) = match executable {
        // No resource mutation or program-valued options. File operands may be
        // expanded, flags or stdin: use an upper bound rather than inventing
        // which files were actually read. Sensitivity/scope is separate.
        "cat" | "head" | "tail" | "nl" | "cut" | "comm" | "paste" | "join" | "fold" | "wc"
        | "od" | "md5sum" | "sha1sum" | "sha256sum" | "sha384sum" | "sha512sum" | "cksum"
        | "readlink" | "realpath" | "uname" | "pwd" | "du" | "df" => {
            (READ, "standard_observer_ceiling/v1")
        }
        // Shell expansions execute separately in the AST. Values printed or
        // transformed by these utilities are not executed by the utility.
        "echo" | "basename" | "dirname" | "tr" | "seq" | "yes" | "sleep" => {
            (0, "standard_stream_transform_ceiling/v1")
        }
        // Includes ordinary replacement, permission changes and optional output
        // files. No effect is called reversible, and no exact read/write label
        // is claimed. Restrictive Read-only states cannot borrow Write here.
        "tee" | "uniq" | "mkdir" | "touch" | "chmod" | "chown" | "chgrp" => {
            (READ | WRITE, "standard_resource_update_ceiling/v1")
        }
        // sort --compress-program, install --strip-program, find -exec, sed e,
        // awk/system, pager/editor and package scripts need child/code evidence.
        // cp --remove-destination and compress/remove tools need finer effects.
        _ => return None,
    };
    Some(Ceiling { upper, contract })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ceilings_are_not_basename_or_delegation_authority() {
        assert_eq!(invariant_ceiling("cat").unwrap().upper, READ);
        assert_eq!(invariant_ceiling("chmod").unwrap().upper, READ | WRITE);
        for name in [
            "/tmp/cat", "./tee", "env", "sudo", "sort", "sed", "awk", "find", "cp", "rm", "sh",
            "npm", "kubectl",
        ] {
            assert!(invariant_ceiling(name).is_none(), "{name}");
        }
    }
}
