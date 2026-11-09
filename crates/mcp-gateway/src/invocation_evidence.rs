//! Argument evidence captured from the same Bash tree as resource effects.
//! Default serialization and Debug omit literal values. The explicit local
//! evaluation projection is only for already-reviewed local/public fixtures;
//! production provider transport requires its own locality/privacy contract.
use crate::bash_classifier;
use serde::Serialize;
use std::fmt;
use tree_sitter::Node;

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct ArgumentEvidence {
    pub start_byte: usize,
    pub end_byte: usize,
    pub grammar_kind: &'static str,
    pub origin: &'static str,
    pub literal_available: bool,
    #[serde(skip)]
    literal_value: Option<String>,
}

impl fmt::Debug for ArgumentEvidence {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("ArgumentEvidence")
            .field("start_byte", &self.start_byte)
            .field("end_byte", &self.end_byte)
            .field("grammar_kind", &self.grammar_kind)
            .field("origin", &self.origin)
            .field("literal_available", &self.literal_available)
            .finish()
    }
}

impl ArgumentEvidence {
    fn capture(node: Node<'_>, source: &str) -> Self {
        let text = node.utf8_text(source.as_bytes()).unwrap_or("");
        let tilde = matches!(node.kind(), "word" | "command_name") && text.starts_with('~');
        let dynamic = tilde || crate::effect_evidence::has_argument_expansion(text);
        let oversized = text.len() > 4096;
        let literal_value = if dynamic || oversized {
            None
        } else {
            bash_classifier::simple_command_tokens(text).and_then(|mut tokens| {
                if tokens.len() == 1 {
                    tokens.pop()
                } else {
                    None
                }
            })
        };
        Self {
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            grammar_kind: node.kind(),
            origin: if oversized {
                "argument_limit"
            } else if tilde {
                "context_expansion"
            } else if dynamic {
                "shell_expansion"
            } else if literal_value.is_some() {
                "literal"
            } else {
                "unresolved"
            },
            literal_available: literal_value.is_some(),
            literal_value,
        }
    }
    fn local_evaluation_json(&self) -> serde_json::Value {
        let mut json = serde_json::to_value(self).expect("argument metadata serializes");
        json["literal_value"] = serde_json::json!(self.literal_value);
        json
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InvocationEvidence {
    pub start_byte: usize,
    pub end_byte: usize,
    pub executable: Option<ArgumentEvidence>,
    pub arguments: Vec<ArgumentEvidence>,
    pub assignments: Vec<ArgumentEvidence>,
    pub argv_complete: bool,
    pub arguments_truncated: bool,
    pub assignments_truncated: bool,
    pub context_ancestors: Vec<&'static str>,
    pub provenance: &'static str,
}

impl InvocationEvidence {
    pub(crate) fn capture(node: Node<'_>, source: &str) -> Self {
        let executable = node
            .child_by_field_name("name")
            .map(|name| ArgumentEvidence::capture(name, source));
        let mut cursor = node.walk();
        let mut arguments = node
            .children_by_field_name("argument", &mut cursor)
            .take(129)
            .map(|arg| ArgumentEvidence::capture(arg, source))
            .collect::<Vec<_>>();
        let mut cursor = node.walk();
        let mut assignments = node
            .named_children(&mut cursor)
            .filter(|child| child.kind() == "variable_assignment")
            .take(129)
            .map(|arg| ArgumentEvidence::capture(arg, source))
            .collect::<Vec<_>>();
        let arguments_truncated = arguments.len() > 128;
        let assignments_truncated = assignments.len() > 128;
        arguments.truncate(128);
        assignments.truncate(128);
        let argv_complete = !arguments_truncated
            && !assignments_truncated
            && executable.as_ref().is_some_and(|arg| arg.literal_available)
            && arguments.iter().all(|arg| arg.literal_available)
            && assignments.iter().all(|arg| arg.literal_available);
        let mut parent = node.parent();
        let mut context_ancestors = Vec::new();
        while let Some(ancestor) = parent {
            if context_ancestors.len() == 32 {
                break;
            }
            context_ancestors.push(ancestor.kind());
            parent = ancestor.parent();
        }
        Self {
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            executable,
            arguments,
            assignments,
            argv_complete,
            arguments_truncated,
            assignments_truncated,
            context_ancestors,
            provenance: "same_native_bash_ast_source",
        }
    }

    /// Explicit private projection for a local evaluation harness that already
    /// validates public/manual-sanitized fixture handling. No live provider
    /// request, ordinary receipt, telemetry or default serializer calls this.
    pub fn local_evaluation_json(&self) -> serde_json::Value {
        let mut json = serde_json::to_value(self).expect("invocation metadata serializes");
        json["executable"] = self
            .executable
            .as_ref()
            .map(ArgumentEvidence::local_evaluation_json)
            .into();
        json["arguments"] = self
            .arguments
            .iter()
            .map(ArgumentEvidence::local_evaluation_json)
            .collect();
        json["assignments"] = self
            .assignments
            .iter()
            .map(ArgumentEvidence::local_evaluation_json)
            .collect();
        json
    }
}

#[cfg(test)]
mod tests {
    use crate::effect_evidence;

    #[test]
    fn source_arguments_preserve_empty_values_flag_values_and_quoted_program_text() {
        let command = "rsync --exclude '' --delete src dst; printf '%s' 'rm -rf fixture'";
        let evidence = effect_evidence::assess(command);
        assert_eq!(evidence.invocations.len(), 2);
        let first = evidence.invocations[0].local_evaluation_json();
        let values = first["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg["literal_value"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, ["--exclude", "", "--delete", "src", "dst"]);
        assert!(evidence.invocations.iter().all(|call| call.argv_complete));
        assert_eq!(
            evidence.invocations[1].local_evaluation_json()["arguments"][1]["literal_value"],
            "rm -rf fixture"
        );
    }

    #[test]
    fn double_quoted_backslashes_preserve_the_actual_shell_argument() {
        let evidence = effect_evidence::assess(r#"printf '%s' "\q" "\"x\"" "\\""#);
        let local = evidence.invocations[0].local_evaluation_json();
        let values = local["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg["literal_value"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, ["%s", r"\q", r#""x""#, r"\"]);
    }

    #[test]
    fn syntax_and_effect_completeness_are_independent() {
        let evidence = effect_evidence::assess("widget --mode observe fixture");
        assert!(evidence.syntax_valid);
        assert!(evidence.invocations[0].argv_complete);
        assert!(!evidence.complete);
        let dynamic = effect_evidence::assess("widget $OPTIONS '*' ~user/file $(cat fixture)");
        assert!(!dynamic.invocations[0].argv_complete);
        let local = dynamic.invocations[0].local_evaluation_json();
        assert_eq!(local["arguments"][0]["origin"], "shell_expansion");
        assert_eq!(
            local["arguments"][0]["literal_value"],
            serde_json::Value::Null
        );
        assert_eq!(local["arguments"][1]["literal_value"], "*");
        assert_eq!(local["arguments"][2]["origin"], "context_expansion");
        assert!(dynamic
            .invocations
            .iter()
            .any(|call| call.context_ancestors.contains(&"command_substitution")));
    }

    #[test]
    fn brace_and_assignment_tilde_expansions_are_not_literal_argv() {
        for command in [
            "printf '%s' {1..3}",
            "utility pre{one,two}",
            "utility pre{one,\"two\"}",
            "VALUE=~/file utility arg",
            "VALUE=path:~/file utility arg",
        ] {
            let evidence = effect_evidence::assess(command);
            assert!(evidence.syntax_valid, "{command}");
            assert!(!evidence.invocations[0].argv_complete, "{command}");
        }
        let quoted = effect_evidence::assess("VALUE='~' printf '%s' '{1..3}'");
        assert!(quoted.invocations[0].argv_complete);
    }

    #[test]
    fn default_serialization_and_debug_do_not_publish_literal_values() {
        let evidence = effect_evidence::assess(
            "curl --header 'Authorization: PRIVATE_VALUE' https://private.invalid/path",
        );
        for text in [
            serde_json::to_string(&evidence).unwrap(),
            format!("{evidence:?}"),
        ] {
            assert!(!text.contains("PRIVATE_VALUE"));
            assert!(!text.contains("private.invalid"));
            assert!(!text.contains("Authorization"));
        }
        assert!(!serde_json::to_string(&evidence)
            .unwrap()
            .contains("source_sha256"));
        assert!(!format!("{evidence:?}").contains(evidence.source_sha256.as_deref().unwrap()));
        let local = evidence.invocations[0].local_evaluation_json().to_string();
        assert!(local.contains("PRIVATE_VALUE"));
    }

    #[test]
    fn argument_limits_preserve_explicit_loss_without_claiming_complete_argv() {
        let many = format!("utility {}", vec!["arg"; 129].join(" "));
        let evidence = effect_evidence::assess(&many);
        assert!(evidence.invocations[0].arguments_truncated);
        assert_eq!(evidence.invocations[0].arguments.len(), 128);
        assert!(!evidence.invocations[0].argv_complete);
        let long = format!("utility '{}'", "x".repeat(4097));
        let evidence = effect_evidence::assess(&long);
        assert_eq!(
            evidence.invocations[0].arguments[0].origin,
            "argument_limit"
        );
        assert!(!evidence.invocations[0].argv_complete);
    }
}
