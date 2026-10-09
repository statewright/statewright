#[cfg(not(unix))]
compile_error!("statewright-native-desktop-launcher currently requires Unix exec semantics");

use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const STATE_ENV: &str = "STATEWRIGHT_DESKTOP_STATE_PATH";

#[derive(Debug, Eq, PartialEq)]
struct Config {
    original_codex: PathBuf,
    node_executable: PathBuf,
    broker_script: PathBuf,
    state_path: PathBuf,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[statewright-native-launcher] {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let argv = env::args_os().collect::<Vec<_>>();
    let argv0 = argv
        .first()
        .cloned()
        .ok_or_else(|| "missing argv[0]".to_string())?;
    let current_exe =
        env::current_exe().map_err(|error| format!("cannot resolve launcher: {error}"))?;
    let config_path = config_path(&current_exe);
    let config = read_config(&config_path)?;
    validate_config(&config, &current_exe)?;

    let error = if is_app_server(&argv[1..]) {
        let mut command = Command::new(&config.node_executable);
        command
            .arg(&config.broker_script)
            .args(&argv[1..])
            .env(STATE_ENV, &config.state_path);
        command.exec()
    } else {
        let mut command = Command::new(&config.original_codex);
        command.arg0(argv0).args(&argv[1..]);
        command.exec()
    };

    Err(format!("exec failed: {error}"))
}

fn config_path(current_exe: &Path) -> PathBuf {
    // The profile sidecar belongs to this exact launcher. An inherited env
    // override could mix a production bridge with a staging state record.
    PathBuf::from(format!("{}.conf", current_exe.display()))
}

fn read_config(path: &Path) -> Result<Config, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read config {}: {error}", path.display()))?;
    parse_config(&contents)
}

fn parse_config(contents: &str) -> Result<Config, String> {
    let mut values = BTreeMap::new();
    for (index, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("config line {} must be key=value", index + 1))?;
        if !matches!(
            key,
            "version" | "original_codex" | "node_executable" | "broker_script" | "state_path"
        ) {
            return Err(format!("unknown config key on line {}: {key}", index + 1));
        }
        if value.is_empty() {
            return Err(format!("config value is empty on line {}", index + 1));
        }
        if values.insert(key, value).is_some() {
            return Err(format!("duplicate config key on line {}: {key}", index + 1));
        }
    }

    let required = |key: &str| {
        values
            .get(key)
            .copied()
            .ok_or_else(|| format!("missing config key: {key}"))
    };
    if required("version")? != "1" {
        return Err("unsupported config version".to_string());
    }
    Ok(Config {
        original_codex: PathBuf::from(required("original_codex")?),
        node_executable: PathBuf::from(required("node_executable")?),
        broker_script: PathBuf::from(required("broker_script")?),
        state_path: PathBuf::from(required("state_path")?),
    })
}

fn validate_config(config: &Config, current_exe: &Path) -> Result<(), String> {
    validate_executable("original_codex", &config.original_codex)?;
    validate_executable("node_executable", &config.node_executable)?;
    validate_regular_file("broker_script", &config.broker_script)?;
    validate_regular_file("state_path", &config.state_path)?;

    let launcher = fs::canonicalize(current_exe).map_err(|error| {
        format!(
            "cannot canonicalize launcher {}: {error}",
            current_exe.display()
        )
    })?;
    let original = fs::canonicalize(&config.original_codex).map_err(|error| {
        format!(
            "cannot canonicalize original_codex {}: {error}",
            config.original_codex.display()
        )
    })?;
    if launcher == original {
        return Err("original_codex points to the launcher itself".to_string());
    }
    Ok(())
}

fn validate_executable(name: &str, path: &Path) -> Result<(), String> {
    validate_regular_file(name, path)?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect {name} {}: {error}", path.display()))?;
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("{name} is not executable: {}", path.display()));
    }
    Ok(())
}

fn validate_regular_file(name: &str, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect {name} {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{name} is not a regular file: {}", path.display()));
    }
    Ok(())
}

fn is_app_server(args: &[OsString]) -> bool {
    let mut args = args.iter();
    while let Some(argument) = args.next() {
        let Some(argument) = argument.to_str() else {
            return false;
        };
        if argument == "app-server" {
            return true;
        }
        if argument == "--" {
            return false;
        }
        if matches!(
            argument,
            "-c" | "--config"
                | "--enable"
                | "--disable"
                | "--remote"
                | "--remote-auth-token-env"
                | "-m"
                | "--model"
                | "--local-provider"
                | "-p"
                | "--profile"
                | "-s"
                | "--sandbox"
                | "-C"
                | "--cd"
                | "--add-dir"
                | "-a"
                | "--ask-for-approval"
        ) {
            if args.next().is_none() {
                return false;
            }
            continue;
        }
        if [
            "--config=",
            "--enable=",
            "--disable=",
            "--remote=",
            "--remote-auth-token-env=",
            "--model=",
            "--local-provider=",
            "--profile=",
            "--sandbox=",
            "--cd=",
            "--add-dir=",
            "--ask-for-approval=",
        ]
        .iter()
        .any(|prefix| argument.starts_with(prefix))
        {
            continue;
        }
        if matches!(
            argument,
            "--strict-config"
                | "--oss"
                | "--approve-for-me"
                | "--dangerously-bypass-approvals-and-sandbox"
                | "--dangerously-bypass-hook-trust"
                | "--worktree"
                | "--search"
                | "--no-alt-screen"
                | "--no-daemon"
        ) {
            continue;
        }
        // Any other positional argument is a prompt or another subcommand.
        // Unknown options also remain the vendor CLI's responsibility.
        return false;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_the_app_server_subcommand() {
        assert!(is_app_server(&[
            OsString::from("-c"),
            OsString::from("model=fast"),
            OsString::from("app-server")
        ]));
        assert!(is_app_server(&[OsString::from("app-server")]));
        assert!(!is_app_server(&[
            OsString::from("-c"),
            OsString::from("app-server")
        ]));
        assert!(!is_app_server(&[
            OsString::from("exec"),
            OsString::from("app-server")
        ]));
        assert!(!is_app_server(&[
            OsString::from("--"),
            OsString::from("app-server")
        ]));
        assert!(!is_app_server(&[OsString::from("exec-server")]));
        assert!(!is_app_server(&[OsString::from("not-app-server")]));
    }

    #[test]
    fn config_is_bound_to_the_launcher_not_an_inherited_environment() {
        assert_eq!(
            config_path(Path::new("/tmp/profile/dispatcher")),
            PathBuf::from("/tmp/profile/dispatcher.conf")
        );
    }

    #[test]
    fn parses_the_complete_versioned_contract() {
        let parsed = parse_config(
            "version=1\noriginal_codex=/tmp/codex\nnode_executable=/tmp/node\nbroker_script=/tmp/broker.mjs\nstate_path=/tmp/state.json\n",
        )
        .unwrap();
        assert_eq!(parsed.original_codex, PathBuf::from("/tmp/codex"));
        assert_eq!(parsed.state_path, PathBuf::from("/tmp/state.json"));
    }

    #[test]
    fn rejects_unknown_duplicate_and_incomplete_configuration() {
        assert!(
            parse_config("version=1\nunknown=x\n")
                .unwrap_err()
                .contains("unknown")
        );
        assert!(
            parse_config("version=1\nversion=1\n")
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(parse_config("version=1\n").unwrap_err().contains("missing"));
    }
}
