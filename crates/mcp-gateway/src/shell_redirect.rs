//! One structural redirection contract shared by read proof and AST effects.
//! No command names, shell evaluation or filesystem access is involved.
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    Discard,
    Descriptor,
    Read,
    Write,
    Unknown,
}

pub(crate) fn effect(node: Node<'_>, source: &[u8]) -> Effect {
    let mut cursor = node.walk();
    let Some(operator) = node
        .children(&mut cursor)
        .filter(|child| !child.is_named())
        .filter_map(|child| child.utf8_text(source).ok())
        .find(|text| [">", ">>", "&>", "&>>", ">|", "<", ">&", "<&", ">&-", "<&-"].contains(text))
    else {
        return Effect::Unknown;
    };
    if matches!(operator, ">&-" | "<&-") {
        return Effect::Descriptor;
    }
    let mut cursor = node.walk();
    let destinations = node
        .children_by_field_name("destination", &mut cursor)
        .collect::<Vec<_>>();
    if destinations.len() != 1 {
        return Effect::Unknown;
    }
    let target = destinations[0];
    let Ok(text) = target.utf8_text(source) else {
        return Effect::Unknown;
    };
    let literal = match target.kind() {
        "word" | "number" | "file_descriptor" => Some(text),
        "raw_string" if text.starts_with('\'') && text.ends_with('\'') => {
            text.get(1..text.len() - 1)
        }
        "string"
            if text.starts_with('"') && text.ends_with('"') && !text.contains(['$', '`', '\\']) =>
        {
            text.get(1..text.len() - 1)
        }
        _ => None,
    };
    let numeric =
        literal.is_some_and(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()));
    if matches!(operator, ">&" | "<&") && numeric {
        return Effect::Descriptor;
    }
    if matches!(operator, ">" | ">>" | "&>" | "&>>" | ">|" | ">&") {
        return if literal == Some("/dev/null") {
            Effect::Discard
        } else {
            Effect::Write
        };
    }
    if operator == "<" {
        Effect::Read
    } else {
        Effect::Unknown
    }
}

fn redirects(command: &str) -> Option<Vec<(std::ops::Range<usize>, Effect)>> {
    if command.len() > 256 * 1024 {
        return None;
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(command, None)?;
    if tree.root_node().has_error() {
        return None;
    }
    fn walk(
        node: Node<'_>,
        source: &[u8],
        depth: usize,
        out: &mut Vec<(std::ops::Range<usize>, Effect)>,
    ) -> Option<()> {
        if depth > 32 || out.len() > 64 {
            return None;
        }
        if node.kind() == "file_redirect" {
            out.push((node.byte_range(), effect(node, source)));
        }
        if matches!(
            node.kind(),
            "heredoc_redirect" | "herestring_redirect" | "process_substitution"
        ) {
            return None;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            walk(child, source, depth + 1, out)?;
        }
        Some(())
    }
    let mut out = vec![];
    walk(tree.root_node(), command.as_bytes(), 0, &mut out)?;
    Some(out)
}

pub(crate) fn has_file_write(command: &str) -> Option<bool> {
    if !command.contains(['<', '>']) {
        return Some(false);
    }
    let redirects = redirects(command)?;
    Some(redirects.iter().any(|(_, effect)| *effect == Effect::Write))
}

/// Strip only proven null-device sinks. Descriptor duplication, arbitrary file
/// destinations, expansions and unsupported syntax remain outside read proof.
pub(crate) fn strip_discard_redirects(command: &str) -> Option<String> {
    if !command.contains(['<', '>']) {
        return Some(command.to_owned());
    }
    let redirects = redirects(command)?;
    if redirects
        .iter()
        .any(|(_, effect)| *effect != Effect::Discard)
    {
        return None;
    }
    let mut normalized = command.to_owned();
    for (range, _) in redirects.iter().rev() {
        normalized.replace_range(range.clone(), " ");
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_sinks_are_equivalent_despite_spacing_quoting_and_descriptor() {
        for sink in [
            "2>/dev/null",
            "2> /dev/null",
            "2>>/dev/null",
            ">'/dev/null'",
            "&> /dev/null",
            "2>\"/dev/null\"",
        ] {
            let source = format!("cat fixture {sink}");
            assert_eq!(has_file_write(&source), Some(false), "{source}");
            assert_eq!(
                strip_discard_redirects(&source).unwrap().trim(),
                "cat fixture"
            );
        }
    }
    #[test]
    fn file_destinations_are_writes_not_descriptor_duplication() {
        for sink in [
            "2>log",
            ">&log",
            ">& log",
            "&>log",
            ">|log",
            ">\"$HOME/log\"",
        ] {
            let source = format!("cat fixture {sink}");
            assert_eq!(has_file_write(&source), Some(true), "{source}");
            assert!(strip_discard_redirects(&source).is_none());
        }
        assert_eq!(has_file_write("cat fixture 2>&1"), Some(false));
        assert!(strip_discard_redirects("cat fixture 2>&1").is_none());
    }
    #[test]
    fn quoted_redirect_data_does_not_become_an_operator() {
        assert_eq!(has_file_write("printf '%s' '2>log'"), Some(false));
        assert_eq!(
            strip_discard_redirects("printf '%s' '2>log'"),
            Some("printf '%s' '2>log'".into())
        );
        assert!(strip_discard_redirects("cat x > /dev/null/log").is_none());
        assert!(strip_discard_redirects("cat x > $(echo /dev/null)").is_none());
        assert!(strip_discard_redirects("cat 'unterminated > /dev/null").is_none());
    }
}
