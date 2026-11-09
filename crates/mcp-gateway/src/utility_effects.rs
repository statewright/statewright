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
        | "readlink" | "realpath" | "uname" | "pwd" | "du" | "df" | "grep" | "egrep" | "fgrep"
        | "tac" | "expand" | "unexpand" | "fmt" | "pr" => (READ, "standard_observer_ceiling/v1"),
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

/// Unlike invariant contracts, these require every argument to be literal.
/// Parse option roles before inspecting programs; an unknown option, missing
/// value or unsupported script grammar never acquires an effect ceiling.
pub(crate) fn literal_ceiling(executable: &str, args: &[&str]) -> Option<Ceiling> {
    let (upper, contract) = match executable {
        // External merge sorting may create temporary files even without -o.
        "sort" if bounded_options(args, Sort) => (READ | WRITE, "sort_no_helpers_ceiling/v1"),
        // diff -l/--paginate can execute pr. They are deliberately unsupported.
        "diff" if bounded_options(args, Diff) => (READ, "diff_no_helpers_ceiling/v1"),
        "sed" if bounded_sed(args) => (READ, "sed_stream_program_ceiling/v1"),
        _ => return None,
    };
    Some(Ceiling { upper, contract })
}

#[derive(Clone, Copy)]
enum Options {
    Sort,
    Diff,
}
use Options::{Diff, Sort};

fn bounded_options(args: &[&str], kind: Options) -> bool {
    let mut index = 0;
    while let Some(&arg) = args.get(index) {
        index += 1;
        if arg == "--" {
            return true;
        }
        if arg == "-" || !arg.starts_with('-') {
            continue;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, value) = long
                .split_once('=')
                .map_or((long, None), |(k, v)| (k, Some(v)));
            let (plain, valued): (&[&str], &[&str]) = match kind {
                Sort => (
                    &[
                        "ignore-leading-blanks",
                        "dictionary-order",
                        "ignore-case",
                        "general-numeric-sort",
                        "human-numeric-sort",
                        "ignore-nonprinting",
                        "month-sort",
                        "numeric-sort",
                        "random-sort",
                        "reverse",
                        "merge",
                        "stable",
                        "unique",
                        "version-sort",
                        "zero-terminated",
                        "debug",
                        "help",
                        "version",
                    ],
                    &[
                        "key",
                        "field-separator",
                        "buffer-size",
                        "temporary-directory",
                        "output",
                        "random-source",
                        "files0-from",
                        "batch-size",
                        "parallel",
                        "sort",
                    ],
                ),
                Diff => (
                    &[
                        "brief",
                        "report-identical-files",
                        "ignore-case",
                        "ignore-tab-expansion",
                        "ignore-trailing-space",
                        "ignore-space-change",
                        "ignore-all-space",
                        "ignore-blank-lines",
                        "text",
                        "strip-trailing-cr",
                        "recursive",
                        "new-file",
                        "unidirectional-new-file",
                        "side-by-side",
                        "left-column",
                        "suppress-common-lines",
                        "minimal",
                        "speed-large-files",
                        "normal",
                        "ed",
                        "forward-ed",
                        "rcs",
                        "help",
                        "version",
                        "no-dereference",
                    ],
                    &[
                        "ignore-matching-lines",
                        "exclude",
                        "exclude-from",
                        "starting-file",
                        "from-file",
                        "to-file",
                        "label",
                        "ifdef",
                        "width",
                        "tabsize",
                        "horizon-lines",
                        "line-format",
                        "old-line-format",
                        "new-line-format",
                        "unchanged-line-format",
                        "old-group-format",
                        "new-group-format",
                        "changed-group-format",
                        "unchanged-group-format",
                    ],
                ),
            };
            if plain.contains(&name) {
                if value.is_some() {
                    return false;
                }
            } else if valued.contains(&name) {
                if value.is_none() {
                    if index == args.len() {
                        return false;
                    }
                    index += 1;
                }
            } else if matches!(kind, Diff) && matches!(name, "unified" | "context") {
                if value.is_some_and(|value| {
                    value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit())
                }) {
                    return false;
                }
            } else if matches!(kind, Sort) && name == "check" {
                if value
                    .is_some_and(|value| !matches!(value, "diagnose-first" | "quiet" | "silent"))
                {
                    return false;
                }
            } else {
                return false;
            }
        } else {
            let mut flags = arg[1..].char_indices().peekable();
            while let Some((offset, flag)) = flags.next() {
                let (plain, valued) = match kind {
                    Sort => ("bdfgihMnRrsuVzcmC", "ktSTo"),
                    Diff => ("abBdeEfHiNnpqrstTwy", "DFILSUWXx"),
                };
                if plain.contains(flag) {
                    continue;
                }
                if matches!(kind, Diff) && matches!(flag, 'u' | 'c') {
                    // GNU's attached optional context count is not more flags.
                    let rest = &arg[offset + 2..];
                    if !rest.is_empty() && !rest.bytes().all(|b| b.is_ascii_digit()) {
                        return false;
                    }
                    break;
                }
                if !valued.contains(flag) {
                    return false;
                }
                if flags.peek().is_none() {
                    if index == args.len() {
                        return false;
                    }
                    index += 1;
                }
                break;
            }
        }
    }
    true
}

fn bounded_sed(args: &[&str]) -> bool {
    let mut index = 0;
    let mut programs = Vec::new();
    let mut options = true;
    while let Some(&arg) = args.get(index) {
        index += 1;
        if options && arg == "--" {
            options = false;
            continue;
        }
        if options && arg.starts_with('-') && arg != "-" {
            match arg {
                "-n" | "-E" | "-r" | "-s" | "-u" | "--quiet" | "--silent" | "--regexp-extended"
                | "--separate" | "--unbuffered" | "--posix" | "--sandbox" => {}
                "-e" | "--expression" => {
                    let Some(program) = args.get(index) else {
                        return false;
                    };
                    programs.push(*program);
                    index += 1;
                }
                _ => {
                    if let Some(program) = arg
                        .strip_prefix("--expression=")
                        .or_else(|| arg.strip_prefix("-e"))
                    {
                        programs.push(program);
                    } else {
                        return false;
                    }
                }
            }
        } else if programs.is_empty() {
            programs.push(arg);
        }
        // Remaining operands are file data, including names after --. Continue
        // parsing options because GNU sed also accepts them after operands.
    }
    // Each -e fragment is checked separately and must be a complete program.
    // Reject fragments whose concatenation could continue a label/command.
    !programs.is_empty() && programs.iter().all(|p| sed_stream_program(p))
}

fn sed_stream_program(program: &str) -> bool {
    // No newline continuations, comments, file commands, brace blocks or
    // extension commands. Escapes inside delimited data never become code.
    if !program.is_ascii() || program.bytes().any(|b| b.is_ascii_control()) {
        return false;
    }
    let bytes = program.as_bytes();
    let mut pos = 0;
    let mut count = 0;
    while pos < bytes.len() {
        while bytes.get(pos) == Some(&b' ') {
            pos += 1;
        }
        if pos == bytes.len() {
            break;
        }
        count += 1;
        if count > 64 {
            return false;
        }
        if sed_address(bytes, &mut pos) {
            if bytes.get(pos) == Some(&b',') {
                pos += 1;
                if !sed_address(bytes, &mut pos) {
                    return false;
                }
            }
        }
        while bytes.get(pos) == Some(&b' ') {
            pos += 1;
        }
        if bytes.get(pos) == Some(&b'!') {
            pos += 1;
        }
        while bytes.get(pos) == Some(&b' ') {
            pos += 1;
        }
        let Some(&command) = bytes.get(pos) else {
            return false;
        };
        pos += 1;
        match command {
            b'd' | b'D' | b'p' | b'P' | b'n' | b'N' | b'h' | b'H' | b'g' | b'G' | b'x' | b'z'
            | b'l' | b'=' | b'q' | b'Q' => {}
            b':' | b'b' | b't' | b'T' => {
                while bytes
                    .get(pos)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    pos += 1;
                }
            }
            b's' | b'y' => {
                let Some(&delimiter) = bytes.get(pos) else {
                    return false;
                };
                if !b"/|:~%#@".contains(&delimiter) {
                    return false;
                }
                pos += 1;
                if !sed_delimited(bytes, &mut pos, delimiter)
                    || !sed_delimited(bytes, &mut pos, delimiter)
                {
                    return false;
                }
                if command == b's' {
                    while bytes
                        .get(pos)
                        .is_some_and(|b| *b == b'g' || *b == b'p' || b.is_ascii_digit())
                    {
                        pos += 1;
                    }
                }
            }
            _ => return false,
        }
        while bytes.get(pos) == Some(&b' ') {
            pos += 1;
        }
        if pos == bytes.len() {
            break;
        }
        if bytes[pos] != b';' {
            return false;
        }
        pos += 1;
    }
    count > 0
}

fn sed_address(bytes: &[u8], pos: &mut usize) -> bool {
    let start = *pos;
    if bytes.get(*pos) == Some(&b'$') {
        *pos += 1;
        return true;
    }
    if bytes.get(*pos) == Some(&b'/') {
        *pos += 1;
        if sed_delimited(bytes, pos, b'/') {
            return true;
        }
        *pos = start;
        return false;
    }
    while bytes.get(*pos).is_some_and(u8::is_ascii_digit) {
        *pos += 1;
    }
    *pos > start
}

fn sed_delimited(bytes: &[u8], pos: &mut usize, delimiter: u8) -> bool {
    while let Some(&byte) = bytes.get(*pos) {
        *pos += 1;
        if byte == delimiter {
            return true;
        }
        // Bracket-expression delimiter rules vary across sed implementations.
        // Decline these data forms rather than misidentify the code boundary.
        if byte == b'[' || byte == b']' {
            return false;
        }
        if byte == b'\\' {
            if bytes.get(*pos).is_none() {
                return false;
            }
            *pos += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stream_options_bind_data_and_never_grant_helper_execution() {
        for args in [
            vec!["-u", "-t,", "-k1,1", "file"],
            vec!["-rn", "-o", "output", "file"],
            vec!["--output=out", "--parallel", "2", "file"],
            vec!["--", "--compress-program=not-an-option"],
        ] {
            assert_eq!(literal_ceiling("sort", &args).unwrap().upper, READ | WRITE);
        }
        for args in [
            vec!["--compress-program=widget", "file"],
            vec!["--compress-program", "widget"],
            vec!["--unknown", "file"],
            vec!["-uZ", "file"],
            vec!["-k"],
            vec!["--output"],
        ] {
            assert!(literal_ceiling("sort", &args).is_none(), "{args:?}");
        }
        for args in [
            vec!["-u3", "before", "after"],
            vec!["-rN", "before", "after"],
            vec!["-I", "unsafe-looking-data", "before", "after"],
            vec!["--label=widget", "before", "after"],
        ] {
            assert_eq!(literal_ceiling("diff", &args).unwrap().upper, READ);
        }
        for args in [
            vec!["-l", "before", "after"],
            vec!["-ul", "before", "after"],
            vec!["--paginate", "before", "after"],
            vec!["--unknown"],
            vec!["--label"],
            vec!["-U"],
        ] {
            assert!(literal_ceiling("diff", &args).is_none(), "{args:?}");
        }
        assert!(literal_ceiling("/tmp/sort", &["-u"]).is_none());
        assert!(literal_ceiling("./sed", &["p"]).is_none());
    }

    #[test]
    fn sed_bounds_program_grammar_instead_of_matching_command_strings() {
        for program in [
            "p",
            "100q",
            "1,20d",
            "/needle/!p",
            "s/old/new/g",
            "s|a\\|b|c|2p",
            "y/abc/xyz/",
            ":a;N;$!ba;s/\\n/ /g",
            "h;g;x;D;P",
            "s@x@e system w output@p",
        ] {
            assert!(bounded_sed(&["-n", "-e", program, "input"]), "{program}");
        }
        // A stream delete or substitution discards data, not a managed resource.
        assert_eq!(
            literal_ceiling("sed", &["1,20d", "input"]).unwrap().upper,
            READ
        );
        for program in [
            "e widget",
            "w output",
            "r input",
            "R input",
            "s/x/y/e",
            "s/x/y/w output",
            "s/x/y/;e widget",
            "p\ne widget",
            "s/x/y/\\\ne widget",
            "{p;e widget}",
            "#comment",
            "s/[a/]/b/",
            "/[a/]/p",
            "s/x/y/;unknown",
            "s/x/y/;w output",
            "s/x/y/\r;e widget",
            "s/x/y/\t;e widget",
            "s/x/y/\0",
            "s/x/y/;:label e widget",
        ] {
            assert!(!bounded_sed(&[program, "input"]), "{program:?}");
        }
        for args in [
            vec!["-f", "program.sed", "input"],
            vec!["--file=program.sed", "input"],
            vec!["-i", "s/x/y/", "input"],
            vec!["--in-place", "p", "input"],
            vec!["--unknown", "p"],
            vec!["-e", "p", "-e", "e widget"],
            vec!["-e", "s/x/y/\\", "-e", "e widget"],
            vec!["-e"],
        ] {
            assert!(literal_ceiling("sed", &args).is_none(), "{args:?}");
        }
        assert!(bounded_sed(&["--", "p", "--file=ordinary-file-name"]));
    }
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
