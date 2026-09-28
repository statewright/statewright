//! Bash AST classifier used first for shadow comparison and, behind a separate
//! development-only authority flag, for bounded shell-effect enforcement.
//!
//! The result deliberately contains no source text, paths, arguments, or
//! heredoc bodies.  Parsing and classification happen locally; only bounded
//! structure and aggregate operation classes are eligible for telemetry.

use crate::bash_classifier::{self, OpClass};
use serde::Serialize;
use tree_sitter::{Node, Parser};

const MAX_AST_DEPTH: usize = 32;
const MAX_EXECUTABLE_NODES: usize = 64;
const MAX_RECURSIVE_SHELL_DEPTH: usize = 8;
const MAX_SHELL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Parsed,
    ParsedWithErrors,
    Unavailable,
    LimitExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellAstSemanticShape {
    pub status: ParseStatus,
    pub executable_nodes: usize,
    pub conditional_nodes: usize,
    pub loop_nodes: usize,
    pub pipeline_nodes: usize,
    pub substitution_nodes: usize,
    pub function_definitions: usize,
    pub redirect_nodes: usize,
    pub shell_heredocs: usize,
    pub foreign_code_heredocs: usize,
    pub data_heredocs: usize,
    pub external_heredocs: usize,
    pub opaque_heredocs: usize,
    pub effect_candidates: Vec<&'static str>,
    pub commands: Vec<bash_classifier::SemanticCommandShape>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AstShadowAssessment {
    pub status: ParseStatus,
    pub executable_nodes: usize,
    pub conditional_nodes: usize,
    pub loop_nodes: usize,
    pub pipeline_nodes: usize,
    pub substitution_nodes: usize,
    pub function_definitions: usize,
    pub redirect_nodes: usize,
    pub shell_heredocs: usize,
    pub foreign_code_heredocs: usize,
    pub data_heredocs: usize,
    pub external_heredocs: usize,
    pub opaque_heredocs: usize,
    pub classes: Vec<OpClass>,
    pub semantic_shapes: Vec<bash_classifier::SemanticCommandShape>,
}

impl AstShadowAssessment {
    fn unavailable(status: ParseStatus) -> Self {
        Self {
            status,
            executable_nodes: 0,
            conditional_nodes: 0,
            loop_nodes: 0,
            pipeline_nodes: 0,
            substitution_nodes: 0,
            function_definitions: 0,
            redirect_nodes: 0,
            shell_heredocs: 0,
            foreign_code_heredocs: 0,
            data_heredocs: 0,
            external_heredocs: 0,
            opaque_heredocs: 0,
            classes: vec![OpClass::Opaque],
            semantic_shapes: Vec::new(),
        }
    }

    fn push_class(&mut self, class: OpClass) {
        if !self.classes.contains(&class) {
            self.classes.push(class);
        }
    }

    fn normalize(&mut self) {
        if self.classes.is_empty() {
            self.classes.push(OpClass::Passthrough);
        }
        self.classes.sort_by_key(|class| *class as u8);
        self.classes.dedup();
        self.semantic_shapes.truncate(MAX_EXECUTABLE_NODES);
    }

    fn absorb_nested(&mut self, nested: AstShadowAssessment) {
        self.executable_nodes = self
            .executable_nodes
            .saturating_add(nested.executable_nodes);
        self.conditional_nodes = self
            .conditional_nodes
            .saturating_add(nested.conditional_nodes);
        self.loop_nodes = self.loop_nodes.saturating_add(nested.loop_nodes);
        self.pipeline_nodes = self.pipeline_nodes.saturating_add(nested.pipeline_nodes);
        self.substitution_nodes = self
            .substitution_nodes
            .saturating_add(nested.substitution_nodes);
        self.function_definitions = self
            .function_definitions
            .saturating_add(nested.function_definitions);
        self.redirect_nodes = self.redirect_nodes.saturating_add(nested.redirect_nodes);
        self.shell_heredocs = self.shell_heredocs.saturating_add(nested.shell_heredocs);
        self.foreign_code_heredocs = self
            .foreign_code_heredocs
            .saturating_add(nested.foreign_code_heredocs);
        self.data_heredocs = self.data_heredocs.saturating_add(nested.data_heredocs);
        self.external_heredocs = self
            .external_heredocs
            .saturating_add(nested.external_heredocs);
        self.opaque_heredocs = self.opaque_heredocs.saturating_add(nested.opaque_heredocs);
        for class in nested.classes {
            self.push_class(class);
        }
        self.semantic_shapes.extend(nested.semantic_shapes);
        if !matches!(nested.status, ParseStatus::Parsed) {
            self.status = nested.status;
            self.push_class(OpClass::Opaque);
        }
    }

    pub fn semantic_shape(&self) -> ShellAstSemanticShape {
        ShellAstSemanticShape {
            status: self.status,
            executable_nodes: self.executable_nodes,
            conditional_nodes: self.conditional_nodes,
            loop_nodes: self.loop_nodes,
            pipeline_nodes: self.pipeline_nodes,
            substitution_nodes: self.substitution_nodes,
            function_definitions: self.function_definitions,
            redirect_nodes: self.redirect_nodes,
            shell_heredocs: self.shell_heredocs,
            foreign_code_heredocs: self.foreign_code_heredocs,
            data_heredocs: self.data_heredocs,
            external_heredocs: self.external_heredocs,
            opaque_heredocs: self.opaque_heredocs,
            effect_candidates: self.classes.iter().map(effect_label).collect(),
            commands: self.semantic_shapes.clone(),
        }
    }
}

fn effect_label(class: &OpClass) -> &'static str {
    match class {
        OpClass::FileWrite => "file_write",
        OpClass::FileModify => "file_modify",
        OpClass::FileRead => "file_read",
        OpClass::ContentSearch => "content_search",
        OpClass::FileSearch => "file_search",
        OpClass::Destructive => "destructive",
        OpClass::Network => "network",
        OpClass::GitWrite => "git_write",
        OpClass::GitRead => "git_read",
        OpClass::LocalWrite => "local_write",
        OpClass::GitLocalWrite => "git_local_write",
        OpClass::SafeOutput => "safe_output",
        OpClass::Opaque => "opaque",
        OpClass::Passthrough => "passthrough",
    }
}

/// Parse one shell submission into executable AST nodes. This function never
/// makes an authorization decision; the caller applies the fail-closed
/// arbitration policy and workflow capability denials.
pub fn assess(command: &str) -> AstShadowAssessment {
    assess_at_depth(command, 0)
}

fn assess_at_depth(command: &str, recursive_shell_depth: usize) -> AstShadowAssessment {
    if command.len() > MAX_SHELL_BYTES || recursive_shell_depth > MAX_RECURSIVE_SHELL_DEPTH {
        return AstShadowAssessment::unavailable(ParseStatus::LimitExceeded);
    }
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return AstShadowAssessment::unavailable(ParseStatus::Unavailable);
    }
    let Some(tree) = parser.parse(command, None) else {
        return AstShadowAssessment::unavailable(ParseStatus::Unavailable);
    };
    let mut assessment = AstShadowAssessment {
        status: if tree.root_node().has_error() {
            ParseStatus::ParsedWithErrors
        } else {
            ParseStatus::Parsed
        },
        executable_nodes: 0,
        conditional_nodes: 0,
        loop_nodes: 0,
        pipeline_nodes: 0,
        substitution_nodes: 0,
        function_definitions: 0,
        redirect_nodes: 0,
        shell_heredocs: 0,
        foreign_code_heredocs: 0,
        data_heredocs: 0,
        external_heredocs: 0,
        opaque_heredocs: 0,
        classes: Vec::new(),
        semantic_shapes: Vec::new(),
    };
    walk(
        tree.root_node(),
        command.as_bytes(),
        0,
        recursive_shell_depth,
        &mut assessment,
    );
    if assessment.executable_nodes > MAX_EXECUTABLE_NODES {
        assessment.status = ParseStatus::LimitExceeded;
        assessment.push_class(OpClass::Opaque);
    }
    if !matches!(assessment.status, ParseStatus::Parsed) {
        assessment.push_class(OpClass::Opaque);
    }
    assessment.normalize();
    assessment
}

fn walk(
    node: Node<'_>,
    source: &[u8],
    depth: usize,
    recursive_shell_depth: usize,
    assessment: &mut AstShadowAssessment,
) {
    if depth > MAX_AST_DEPTH || assessment.executable_nodes > MAX_EXECUTABLE_NODES {
        assessment.status = ParseStatus::LimitExceeded;
        assessment.push_class(OpClass::Opaque);
        return;
    }

    match node.kind() {
        // Function bodies are definitions, not effects at definition time.
        // Invoking the function later remains opaque to this isolated parse.
        "function_definition" => {
            assessment.executable_nodes += 1;
            assessment.function_definitions += 1;
            assessment.push_class(OpClass::LocalWrite);
            return;
        }
        "command" => {
            assessment.executable_nodes += 1;
            if let Ok(text) = node.utf8_text(source) {
                let mut classes = bash_classifier::classify(text);
                // Shell expansion in an operand makes the legacy token parser
                // opaque, but the Bash AST still proves an exact literal Git
                // executable and read-only subcommand. Later arguments cannot
                // turn these particular subcommands into Git writes; nested
                // substitutions are walked independently below.
                if classes == [OpClass::Opaque] && ast_proven_git_read(node, source) {
                    classes = vec![OpClass::GitRead];
                }
                // The legacy operation classifier intentionally leaves a
                // small set of stdout/metadata commands as Passthrough. At an
                // AST command leaf we can reuse its stricter read-only proof
                // without confusing surrounding control-flow syntax for an
                // executable.
                if classes == [OpClass::Passthrough]
                    && bash_classifier::readonly_capabilities(text).is_some()
                {
                    classes = vec![OpClass::SafeOutput];
                }
                for class in classes {
                    assessment.push_class(class);
                }
                if let Some(shapes) = bash_classifier::semantic_command_shapes(text) {
                    assessment
                        .semantic_shapes
                        .extend(shapes.into_iter().map(sanitize_semantic_shape));
                }
                classify_inline_shell(text, recursive_shell_depth, assessment);
            } else {
                assessment.push_class(OpClass::Opaque);
            }
        }
        "redirected_statement" => {
            assessment.redirect_nodes += 1;
            classify_redirected_statement(node, source, recursive_shell_depth, assessment)
        }
        "if_statement" | "case_statement" => assessment.conditional_nodes += 1,
        "for_statement" | "c_style_for_statement" | "while_statement" => assessment.loop_nodes += 1,
        "pipeline" => assessment.pipeline_nodes += 1,
        "command_substitution" | "process_substitution" | "subshell" => {
            assessment.substitution_nodes += 1
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, source, depth + 1, recursive_shell_depth, assessment);
    }
}

fn ast_proven_git_read(command: Node<'_>, source: &[u8]) -> bool {
    let literal_label = |node: Node<'_>| {
        node.utf8_text(source).ok().filter(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    };
    let Some(name) = command.child_by_field_name("name").and_then(literal_label) else {
        return false;
    };
    let Some(operation) = command
        .child_by_field_name("argument")
        .and_then(literal_label)
    else {
        return false;
    };
    name == "git"
        && matches!(
            operation,
            "ls-files" | "ls-tree" | "merge-base" | "rev-parse" | "show-ref" | "status"
        )
}

fn sanitize_semantic_shape(
    mut shape: bash_classifier::SemanticCommandShape,
) -> bash_classifier::SemanticCommandShape {
    let known = matches!(
        shape.executable.as_str(),
        "apply_patch"
            | "awk"
            | "bash"
            | "cat"
            | "cargo"
            | "cmake"
            | "cp"
            | "curl"
            | "cut"
            | "dash"
            | "dd"
            | "docker"
            | "echo"
            | "eval"
            | "fd"
            | "file"
            | "find"
            | "git"
            | "go"
            | "grep"
            | "head"
            | "install"
            | "jq"
            | "ksh"
            | "less"
            | "ls"
            | "make"
            | "mkdir"
            | "more"
            | "mv"
            | "mysql"
            | "nc"
            | "ncat"
            | "netcat"
            | "node"
            | "npm"
            | "patch"
            | "perl"
            | "pnpm"
            | "podman"
            | "printf"
            | "psql"
            | "pwd"
            | "pytest"
            | "python"
            | "python3"
            | "read"
            | "rg"
            | "ripgrep"
            | "rm"
            | "rmdir"
            | "rsync"
            | "ruby"
            | "rustc"
            | "scp"
            | "sed"
            | "sftp"
            | "sh"
            | "shred"
            | "sort"
            | "sqlite3"
            | "ssh"
            | "stat"
            | "systemctl"
            | "tail"
            | "task"
            | "tee"
            | "test"
            | "tmux"
            | "tr"
            | "truncate"
            | "uniq"
            | "unlink"
            | "wc"
            | "wget"
            | "xargs"
            | "yq"
            | "zsh"
    );
    if !known {
        shape.executable = "unknown".to_owned();
        shape.operation = None;
        shape.delegates_unknown_effect = true;
    }
    shape
}

fn classify_redirected_statement(
    statement: Node<'_>,
    source: &[u8],
    recursive_shell_depth: usize,
    assessment: &mut AstShadowAssessment,
) {
    let consumer = statement
        .child_by_field_name("body")
        .and_then(|body| body.utf8_text(source).ok())
        .map(command_consumer)
        .unwrap_or(HeredocConsumer::Unknown);
    let mut cursor = statement.walk();
    for child in statement.children(&mut cursor) {
        match child.kind() {
            "heredoc_redirect" => {
                classify_heredoc(child, consumer, source, recursive_shell_depth, assessment)
            }
            "file_redirect" => classify_file_redirect(child, source, assessment),
            _ => {}
        }
    }
}

fn classify_heredoc(
    redirect: Node<'_>,
    consumer: HeredocConsumer,
    source: &[u8],
    recursive_shell_depth: usize,
    assessment: &mut AstShadowAssessment,
) {
    let Some(body) = heredoc_body(redirect, source) else {
        assessment.opaque_heredocs += 1;
        assessment.push_class(OpClass::Opaque);
        return;
    };
    match consumer {
        HeredocConsumer::Shell => {
            assessment.shell_heredocs += 1;
            let nested = assess_at_depth(body, recursive_shell_depth + 1);
            assessment.absorb_nested(nested);
        }
        HeredocConsumer::ForeignCode => {
            assessment.foreign_code_heredocs += 1;
            assessment.push_class(OpClass::Opaque);
        }
        HeredocConsumer::PatchOrWrite => assessment.push_class(OpClass::FileModify),
        HeredocConsumer::ExternalShell => {
            assessment.external_heredocs += 1;
            assessment.push_class(OpClass::Network);
            assessment.push_class(OpClass::Opaque);
            let nested = assess_at_depth(body, recursive_shell_depth + 1);
            assessment.absorb_nested(nested);
        }
        HeredocConsumer::ExternalData => {
            assessment.external_heredocs += 1;
            assessment.push_class(OpClass::Network);
            assessment.push_class(OpClass::Opaque);
        }
        HeredocConsumer::Data => assessment.data_heredocs += 1,
        HeredocConsumer::Unknown => {
            assessment.opaque_heredocs += 1;
            assessment.push_class(OpClass::Opaque);
        }
    }
}

fn classify_inline_shell(
    command: &str,
    recursive_shell_depth: usize,
    assessment: &mut AstShadowAssessment,
) {
    let Some(tokens) = bash_classifier::simple_command_tokens(command) else {
        return;
    };
    let (executable, arguments) = unwrap_command(&tokens);
    if !matches!(executable, Some("bash" | "sh" | "dash" | "ksh" | "zsh")) {
        return;
    }
    let Some(arguments) = arguments else {
        return;
    };
    let Some(command_index) = arguments.iter().position(|argument| {
        argument == "-c"
            || (argument.starts_with('-')
                && !argument.starts_with("--")
                && argument[1..].contains('c'))
    }) else {
        return;
    };
    let Some(script) = arguments.get(command_index + 1) else {
        assessment.push_class(OpClass::Opaque);
        return;
    };
    let nested = assess_at_depth(script, recursive_shell_depth + 1);
    assessment.absorb_nested(nested);
}

fn classify_file_redirect(redirect: Node<'_>, source: &[u8], assessment: &mut AstShadowAssessment) {
    let Ok(text) = redirect.utf8_text(source) else {
        assessment.push_class(OpClass::Opaque);
        return;
    };
    let compact: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact.contains(">&") || compact.contains("<&") {
        return;
    }
    if compact.contains('>') {
        assessment.push_class(OpClass::FileWrite);
    } else if compact.contains('<') {
        assessment.push_class(OpClass::FileRead);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeredocConsumer {
    Shell,
    ForeignCode,
    PatchOrWrite,
    ExternalShell,
    ExternalData,
    Data,
    Unknown,
}

fn command_consumer(command: &str) -> HeredocConsumer {
    let Some(tokens) = bash_classifier::simple_command_tokens(command) else {
        return HeredocConsumer::Unknown;
    };
    let (executable, _) = unwrap_command(&tokens);
    let executable = executable.unwrap_or_default();
    match executable {
        "bash" | "sh" | "dash" | "ksh" | "zsh" => HeredocConsumer::Shell,
        "python" | "python3" | "node" | "ruby" | "perl" => HeredocConsumer::ForeignCode,
        "apply_patch" | "patch" | "tee" => HeredocConsumer::PatchOrWrite,
        "ssh" => HeredocConsumer::ExternalShell,
        "scp" | "sftp" | "curl" | "wget" | "psql" | "mysql" | "sqlite3" => {
            HeredocConsumer::ExternalData
        }
        "cat" | "read" | "wc" | "grep" | "rg" | "sed" | "awk" | "jq" => HeredocConsumer::Data,
        "" => HeredocConsumer::Unknown,
        _ => HeredocConsumer::Unknown,
    }
}

fn unwrap_command(tokens: &[String]) -> (Option<&str>, Option<&[String]>) {
    let mut index = 0;
    while tokens
        .get(index)
        .is_some_and(|token| token.contains('=') && !token.starts_with('='))
    {
        index += 1;
    }
    loop {
        let Some(token) = tokens.get(index) else {
            return (None, None);
        };
        let Some(executable) = token.rsplit('/').next() else {
            return (None, None);
        };
        match executable {
            "command" | "exec" | "nohup" => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| token.starts_with('-'))
                {
                    index += 1;
                }
            }
            "env" => {
                index += 1;
                while tokens.get(index).is_some_and(|token| {
                    token.starts_with('-') || (token.contains('=') && !token.starts_with('='))
                }) {
                    index += 1;
                }
            }
            _ => return (Some(executable), tokens.get(index + 1..)),
        }
    }
}

fn heredoc_body<'a>(redirect: Node<'_>, source: &'a [u8]) -> Option<&'a str> {
    let mut cursor = redirect.walk();
    redirect
        .children(&mut cursor)
        .find(|child| child.kind() == "heredoc_body")?
        .utf8_text(source)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_logical_pipelines_and_substitutions() {
        let safe = assess("tmux capture-pane -p -t %36 | tail -80 && git rev-parse HEAD");
        assert_eq!(safe.status, ParseStatus::Parsed);
        assert!(safe.classes.contains(&OpClass::GitRead));
        assert!(!safe.classes.contains(&OpClass::GitWrite));

        let dangerous = assess("git rev-parse HEAD && echo \"$(git push origin HEAD)\"");
        assert!(dangerous.classes.contains(&OpClass::GitRead));
        assert!(dangerous.classes.contains(&OpClass::GitWrite));
    }

    #[test]
    fn shell_heredoc_body_is_recursively_classified_even_when_delimiter_is_quoted() {
        let command = "bash <<'EOF'\ngit rev-parse HEAD\ngit push origin HEAD\nEOF";
        let result = assess(command);
        assert_eq!(result.shell_heredocs, 1);
        assert!(result.classes.contains(&OpClass::GitRead));
        assert!(result.classes.contains(&OpClass::GitWrite));
    }

    #[test]
    fn cat_heredoc_is_data_but_redirect_is_a_write() {
        let result = assess("cat > artifact.txt <<'EOF'\ngit push origin HEAD\nEOF");
        assert_eq!(result.shell_heredocs, 0);
        assert!(!result.classes.contains(&OpClass::GitWrite));
        assert!(result.classes.contains(&OpClass::FileWrite));
    }

    #[test]
    fn foreign_code_and_unknown_consumers_stay_opaque() {
        let python = assess("python3 <<'PY'\nopen('artifact', 'w').write('x')\nPY");
        assert_eq!(python.foreign_code_heredocs, 1);
        assert!(python.classes.contains(&OpClass::Opaque));

        let unknown = assess("custom-runner <<'EOF'\nmutate everything\nEOF");
        assert_eq!(unknown.opaque_heredocs, 1);
        assert!(unknown.classes.contains(&OpClass::Opaque));
    }

    #[test]
    fn semantic_shapes_never_forward_custom_executable_names_from_code_bodies() {
        let result =
            assess("bash <<'EOF'\nprivate_client_runner --token private-client-token\nEOF");
        assert!(
            result
                .semantic_shapes
                .iter()
                .any(|shape| { shape.executable == "unknown" && shape.delegates_unknown_effect })
        );
        let serialized = serde_json::to_string(&result.semantic_shape()).unwrap();
        assert!(!serialized.contains("private_client_runner"));
        assert!(!serialized.contains("private-client-token"));
    }

    #[test]
    fn external_heredoc_never_looks_local() {
        let result = assess("ssh host <<'EOF'\nrm -rf /srv/app\nEOF");
        assert!(result.classes.contains(&OpClass::Network));
        assert!(result.classes.contains(&OpClass::Destructive));
        assert_eq!(result.external_heredocs, 1);
    }

    #[test]
    fn inline_shell_programs_and_wrapped_shell_heredocs_are_recursive() {
        let inline = assess("bash -lc 'git rev-parse HEAD && git push origin HEAD'");
        assert!(inline.classes.contains(&OpClass::GitRead));
        assert!(inline.classes.contains(&OpClass::GitWrite));

        let wrapped = assess("env CLEAN=1 command bash <<'EOF'\nrm -rf generated\nEOF");
        assert_eq!(wrapped.shell_heredocs, 1);
        assert!(wrapped.classes.contains(&OpClass::Destructive));
    }

    #[test]
    fn compound_control_flow_exposes_every_possible_executable_branch() {
        for command in [
            "if git rev-parse HEAD; then git push origin HEAD; fi",
            "for item in one two; do rm -rf \"$item\"; done",
            "git rev-parse HEAD || git push origin HEAD",
        ] {
            let result = assess(command);
            assert!(
                result.classes.contains(&OpClass::GitWrite)
                    || result.classes.contains(&OpClass::Destructive),
                "{command}: {:?}",
                result.classes
            );
        }
    }

    #[test]
    fn read_only_loop_has_no_opaque_effect() {
        let result = assess("for reference in HEAD main; do git rev-parse \"$reference\"; done");
        assert_eq!(result.status, ParseStatus::Parsed);
        assert!(
            result.classes.contains(&OpClass::GitRead),
            "{:?}",
            result.classes
        );
        assert!(
            !result.classes.contains(&OpClass::Opaque),
            "{:?}",
            result.classes
        );
        assert!(
            !result.classes.contains(&OpClass::Passthrough),
            "{:?}",
            result.classes
        );
    }

    #[test]
    fn expanded_git_executable_or_operation_stays_unresolved() {
        for command in [
            "git \"$operation\" origin HEAD",
            "\"$executable\" rev-parse HEAD",
        ] {
            let result = assess(command);
            assert!(
                result
                    .classes
                    .iter()
                    .any(|class| { matches!(class, OpClass::Opaque | OpClass::Passthrough) }),
                "{command}"
            );
            assert!(!result.classes.contains(&OpClass::GitRead), "{command}");
        }
        let nested = assess("git rev-parse \"$(git push origin HEAD)\"");
        assert!(nested.classes.contains(&OpClass::GitRead));
        assert!(nested.classes.contains(&OpClass::GitWrite));
    }
}
