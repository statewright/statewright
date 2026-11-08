//! Literal CLI structure inside a shell command leaf. Parsing is not authority.
//! Values stay local; the semantic projection deliberately records evidence loss.
use crate::bash_classifier::{self, LiteralInvocation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliNode {
    pub operation_index: usize,
    pub options: Vec<String>,
    pub operands: Vec<usize>,
    pub delegated_argv: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ExecutionShape {
    pub executable: String,
    pub operation: Option<String>,
    pub options: Vec<String>,
    pub location: &'static str,
    pub syntax_complete: bool,
    pub operand_values_omitted: bool,
    pub effects: Vec<&'static str>,
    pub children: Vec<ExecutionShape>,
}

// Known arity is essential: skipping every '-' token would mistake an option
// value for the operation. Unknown spellings remain missing evidence.
fn option_arity(executable: &str, operation: Option<&str>, flag: &str) -> Option<bool> {
    Some(match (executable, flag) {
        (
            "kubectl",
            "--kubeconfig"
            | "--context"
            | "--cluster"
            | "--user"
            | "-n"
            | "--namespace"
            | "--request-timeout"
            | "--server"
            | "-s"
            | "--token"
            | "--client-certificate"
            | "--client-key"
            | "--certificate-authority"
            | "--as"
            | "--as-group"
            | "--as-uid",
        ) => true,
        (
            "kubectl",
            "--insecure-skip-tls-verify" | "--disable-compression" | "--warnings-as-errors",
        ) => false,
        (
            "kubectl",
            "-o" | "--output" | "-l" | "--selector" | "--field-selector" | "--sort-by"
            | "--chunk-size",
        ) if operation == Some("get") => true,
        (
            "kubectl",
            "-A"
            | "--all-namespaces"
            | "--show-labels"
            | "--no-headers"
            | "--ignore-not-found"
            | "--show-kind"
            | "--show-managed-fields"
            | "--allow-missing-template-keys",
        ) if operation == Some("get") => false,
        ("kubectl", "-c" | "--container" | "--pod-running-timeout")
            if operation == Some("exec") =>
        {
            true
        }
        ("kubectl", "-i" | "--stdin" | "-t" | "--tty" | "-q" | "--quiet")
            if operation == Some("exec") =>
        {
            false
        }
        ("docker" | "podman", "--context" | "--host" | "-H" | "--config" | "--log-level") => true,
        ("docker" | "podman", "--debug" | "-D" | "--tls" | "--tlsverify") => false,
        ("docker" | "podman", "--user" | "-u" | "--workdir" | "-w" | "--env" | "-e")
            if operation == Some("exec") =>
        {
            true
        }
        ("docker" | "podman", "--interactive" | "-i" | "--tty" | "-t")
            if operation == Some("exec") =>
        {
            false
        }
        ("cargo", "--manifest-path" | "--color" | "--target-dir" | "--config" | "-C" | "-Z") => {
            true
        }
        (
            "cargo",
            "--offline" | "--locked" | "--frozen" | "--quiet" | "-q" | "--verbose" | "-v",
        ) => false,
        _ => return None,
    })
}

/// Shared operation/option/delegation boundaries for deterministic and semantic
/// consumers. Never invoke a CLI, resolve a plugin, or interpret a value here.
pub(crate) fn operation_index(executable: &str, args: &[String]) -> Option<usize> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if !arg.starts_with('-') {
            return Some(index);
        }
        let (flag, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        if option_arity(executable, None, flag)? {
            if inline.is_none() {
                index += 1;
            }
            let value = inline.or_else(|| args.get(index).map(String::as_str))?;
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
        } else if inline.is_some_and(|value| !matches!(value, "true" | "false")) {
            return None;
        }
        index += 1;
    }
    None
}

pub(crate) fn cli_node(executable: &str, args: &[String]) -> Option<CliNode> {
    if args.len() > 128 {
        return None;
    }
    let mut index = 0;
    let mut operation = None;
    let mut options = Vec::new();
    let mut operands = Vec::new();
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            let op = operation?;
            if args[op] == "exec" && matches!(executable, "kubectl" | "docker" | "podman") {
                if operands.len() != 1 || index + 1 == args.len() {
                    return None;
                }
                return Some(CliNode {
                    operation_index: op,
                    options,
                    operands,
                    delegated_argv: Some(args[index + 1..].to_vec()),
                });
            }
            operands.extend(index + 1..args.len());
            break;
        }
        if arg.starts_with('-') {
            let (flag, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
            let takes_value =
                option_arity(executable, operation.map(|op| args[op].as_str()), flag)?;
            options.push(flag.to_owned());
            if takes_value {
                let value = if let Some(value) = inline {
                    value
                } else {
                    index += 1;
                    args.get(index)?.as_str()
                };
                if value.is_empty() || value.starts_with('-') {
                    return None;
                }
            } else if inline.is_some_and(|value| !matches!(value, "true" | "false")) {
                return None;
            }
        } else if operation.is_none() {
            operation = Some(index);
        } else {
            if matches!(executable, "docker" | "podman")
                && operation.is_some_and(|op| args[op] == "exec")
                && operands.len() == 1
            {
                return Some(CliNode {
                    operation_index: operation?,
                    options,
                    operands,
                    delegated_argv: Some(args[index..].to_vec()),
                });
            }
            operands.push(index);
        }
        index += 1;
    }
    Some(CliNode {
        operation_index: operation?,
        options,
        operands,
        delegated_argv: None,
    })
}

pub(crate) fn kubectl_read(invocation: &LiteralInvocation) -> bool {
    if invocation.executable.rsplit('/').next() != Some("kubectl") {
        return false;
    }
    let Some(node) = cli_node("kubectl", &invocation.args) else {
        return false;
    };
    if invocation.args[node.operation_index] != "get" || node.operands.is_empty() {
        return false;
    }
    // --raw, file/template-file input, profiling, watch and unknown flags do
    // not enter this proof. Output formats here are stdout renderers only.
    for (index, arg) in invocation.args.iter().enumerate() {
        let (flag, value) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
        if matches!(flag, "-o" | "--output") {
            let Some(value) = value.or_else(|| invocation.args.get(index + 1).map(String::as_str))
            else {
                return false;
            };
            if !matches!(value, "json" | "yaml" | "wide" | "name")
                && !value.starts_with("jsonpath=")
                && !value.starts_with("jsonpath-as-json=")
            {
                return false;
            }
        }
    }
    true
}

pub(crate) fn execution_shape(
    invocation: &LiteralInvocation,
    location: &'static str,
    depth: usize,
) -> ExecutionShape {
    let executable = invocation.executable.rsplit('/').next().unwrap_or("");
    let known = matches!(
        executable,
        "kubectl"
            | "docker"
            | "podman"
            | "cargo"
            | "npm"
            | "pnpm"
            | "cat"
            | "grep"
            | "rg"
            | "git"
            | "rm"
            | "sh"
            | "bash"
            | "node"
            | "psql"
    );
    let node = cli_node(executable, &invocation.args);
    let operation = bash_classifier::semantic_command_shapes_for_invocation(invocation);
    let mut children = Vec::new();
    let mut syntax_complete = node.is_some();
    if depth < 4 {
        if let Some(argv) = node.as_ref().and_then(|node| node.delegated_argv.as_ref()) {
            children.push(execution_shape(
                &LiteralInvocation {
                    executable: argv[0].clone(),
                    args: argv[1..].to_vec(),
                    environment_names: Vec::new(),
                    wrappers: Vec::new(),
                },
                "external",
                depth + 1,
            ));
        }
        if matches!(executable, "sh" | "bash")
            && invocation.args.len() == 2
            && invocation.args[0] == "-c"
        {
            let nested = crate::shell_ast_shadow::assess_at_depth(&invocation.args[1], depth + 1);
            syntax_complete = nested.status == crate::shell_ast_shadow::ParseStatus::Parsed;
            children.extend(nested.execution_structure.into_iter().map(|mut child| {
                fn inherit(node: &mut ExecutionShape, location: &'static str) {
                    node.location = location;
                    for child in &mut node.children {
                        inherit(child, location);
                    }
                }
                // A local shell may itself call a remote launcher. Only an
                // external enclosing context propagates outward; local must
                // never erase a child's explicit remote boundary.
                if location == "external" {
                    inherit(&mut child, location);
                }
                child
            }));
        }
    } else if node
        .as_ref()
        .is_some_and(|node| node.delegated_argv.is_some())
        || matches!(executable, "sh" | "bash")
    {
        syntax_complete = false;
    }
    // Rendering is exclusively for static parsing, never execution. Quote each
    // argv element to preserve an inner 'rm' as an executable but 'rm -rf' as
    // one literal operand when that was what the outer shell supplied.
    let text = std::iter::once(&invocation.executable)
        .chain(&invocation.args)
        .map(|value| format!("'{}'", value.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ");
    let effects = bash_classifier::classify(&text)
        .iter()
        .map(crate::shell_ast_shadow::effect_label)
        .collect();
    ExecutionShape {
        executable: if known {
            executable.to_owned()
        } else {
            "unknown".to_owned()
        },
        operation,
        options: node
            .as_ref()
            .map(|node| node.options.clone())
            .unwrap_or_default(),
        location,
        syntax_complete,
        operand_values_omitted: true,
        effects,
        children,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_flags_and_delegation_preserve_argv_boundaries_not_private_values() {
        let invocation = bash_classifier::literal_invocation("kubectl --kubeconfig=PRIVATE --request-timeout 5s -n target exec pod -c app -- cat /private/path").unwrap();
        let node = cli_node("kubectl", &invocation.args).unwrap();
        assert_eq!(invocation.args[node.operation_index], "exec");
        assert_eq!(node.delegated_argv.unwrap(), ["cat", "/private/path"]);
        let shape = execution_shape(&invocation, "external", 0);
        assert_eq!(shape.children[0].executable, "cat");
        assert_eq!(shape.children[0].location, "external");
        let json = serde_json::to_string(&shape).unwrap();
        for private in ["PRIVATE", "target", "/private/path"] {
            assert!(!json.contains(private));
        }
    }
    #[test]
    fn missing_unknown_options_and_empty_children_do_not_manufacture_proof() {
        for command in [
            "kubectl -n",
            "kubectl --mystery get pods",
            "kubectl exec pod --",
            "kubectl exec pod extra -- cat x",
        ] {
            let invocation = bash_classifier::literal_invocation(command).unwrap();
            assert!(cli_node("kubectl", &invocation.args).is_none(), "{command}");
        }
        for command in [
            "cargo --offline test",
            "docker --context local exec box -- cat file",
            "podman --host remote ps",
        ] {
            let invocation = bash_classifier::literal_invocation(command).unwrap();
            assert!(
                cli_node(&invocation.executable, &invocation.args).is_some(),
                "{command}"
            );
        }
        let cargo = bash_classifier::semantic_command_shapes(
            "cargo --offline test -p component -- --nocapture",
        )
        .unwrap();
        assert_eq!(cargo[0].operation.as_deref(), Some("test"));
        let docker = bash_classifier::literal_invocation(
            "docker --context local exec box cat /private/file",
        )
        .unwrap();
        assert_eq!(
            cli_node("docker", &docker.args)
                .unwrap()
                .delegated_argv
                .unwrap(),
            ["cat", "/private/file"]
        );
    }

    #[test]
    fn remote_shell_payload_is_a_nested_ast_with_each_effect_not_a_kubectl_label() {
        let ast = crate::shell_ast_shadow::assess(
            "kubectl -n target exec pod -- sh -c 'cat /private/file; rm /private/output'",
        );
        let parent = &ast.execution_structure[0];
        assert_eq!(parent.operation.as_deref(), Some("exec"));
        assert_eq!(parent.children[0].executable, "sh");
        let units = &parent.children[0].children;
        assert_eq!(units.len(), 2);
        assert_eq!(units[0].executable, "cat");
        assert_eq!(units[1].executable, "rm");
        assert!(units[1].effects.contains(&"destructive"));
        assert!(units.iter().all(|node| node.location == "external"));
        assert!(!serde_json::to_string(parent).unwrap().contains("/private"));
        // Knowing an inner read does not silently supply remote executable or
        // target authority. That missing evidence stays explicit on the parent.
        assert!(
            ast.classes
                .contains(&bash_classifier::OpClass::ExternalUnknown)
        );
        let local_shell =
            crate::shell_ast_shadow::assess("sh -c 'kubectl exec pod -- cat /private/file'");
        let remote = &local_shell.execution_structure[0].children[0];
        assert_eq!(remote.location, "external");
        assert_eq!(remote.children[0].location, "external");
    }
}
