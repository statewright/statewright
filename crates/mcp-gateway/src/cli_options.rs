//! Bounded literal argv binding, independent of utility names or authorization.
//! Unknown options/abbreviations are missing evidence, not ignorable flags.

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct OptionBinding<'a> {
    pub name: String,
    pub value: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BoundArgv<'a> {
    pub options: Vec<OptionBinding<'a>>,
    pub operands: Vec<&'a str>,
}

/// `arity` supplies a reviewed CLI schema: false=flag, true=one value.
/// GNU-style option permutation is explicit here; `--` ends option parsing.
/// Short clusters and attached values retain their bindings. No shell parsing,
/// abbreviation inference, binary/plugin execution or value interpretation.
pub(crate) fn bind<'a>(
    args: &'a [String],
    arity: impl Fn(&str) -> Option<bool>,
) -> Option<BoundArgv<'a>> {
    if args.len() > 128 {
        return None;
    }
    let mut result = BoundArgv {
        options: Vec::new(),
        operands: Vec::new(),
    };
    let mut index = 0;
    let mut options = true;
    while index < args.len() {
        let arg = &args[index];
        if options && arg == "--" {
            options = false;
            index += 1;
            continue;
        }
        if options && arg.starts_with("--") {
            let (name, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
            let takes_value = arity(name)?;
            let value = if takes_value {
                if let Some(v) = inline {
                    Some(v)
                } else {
                    index += 1;
                    Some(args.get(index)?.as_str())
                }
            } else {
                if inline.is_some() {
                    return None;
                }
                None
            };
            result.options.push(OptionBinding {
                name: name.to_owned(),
                value,
            });
        } else if options && arg.starts_with('-') && arg != "-" {
            let mut chars = arg.char_indices().skip(1).peekable();
            while let Some((offset, letter)) = chars.next() {
                if !letter.is_ascii_alphabetic() {
                    return None;
                }
                let name = format!("-{letter}");
                let value = if arity(&name)? {
                    let end = offset + letter.len_utf8();
                    let value = if end < arg.len() {
                        &arg[end..]
                    } else {
                        index += 1;
                        args.get(index)?.as_str()
                    };
                    Some(value)
                } else {
                    None
                };
                let consumed_value = value.is_some();
                result.options.push(OptionBinding { name, value });
                if consumed_value {
                    break;
                }
            }
        } else {
            result.operands.push(arg);
        }
        index += 1;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn schema(flag: &str) -> Option<bool> {
        match flag {
            "-a" | "-v" | "--delete" => Some(false),
            "-e" | "--exclude" => Some(true),
            _ => None,
        }
    }
    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn values_do_not_become_flags_and_terminator_retains_operands() {
        let args = argv(&["--exclude", "--delete", "src", "--", "--delete"]);
        let result = bind(&args, schema).unwrap();
        assert_eq!(
            result.options,
            vec![OptionBinding {
                name: "--exclude".into(),
                value: Some("--delete")
            }]
        );
        assert_eq!(result.operands, ["src", "--delete"]);
    }
    #[test]
    fn short_clusters_and_attached_values_share_one_binding_contract() {
        for spellings in [&["-av", "-e", "shell"][..], &["-aveshell"][..]] {
            let args = argv(spellings);
            let result = bind(&args, schema).unwrap();
            assert_eq!(
                result
                    .options
                    .iter()
                    .map(|o| o.name.as_str())
                    .collect::<Vec<_>>(),
                ["-a", "-v", "-e"]
            );
            assert_eq!(result.options[2].value, Some("shell"));
        }
    }
    #[test]
    fn unknown_flags_missing_values_and_unproven_abbreviations_are_unresolved() {
        for args in [
            &["--excl=x"][..],
            &["--exclude"][..],
            &["-avQ"][..],
            &["--delete=x"][..],
        ] {
            assert!(bind(&argv(args), schema).is_none());
        }
    }
}
