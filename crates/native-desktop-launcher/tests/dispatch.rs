#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "statewright-native-dispatch-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn dispatch_uses_its_own_sidecar_and_preserves_non_server_subcommands() {
    let fixture = Fixture::new();
    let launcher = fixture.path("launcher");
    fs::copy(
        env!("CARGO_BIN_EXE_statewright-native-desktop-launcher"),
        &launcher,
    )
    .unwrap();
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();

    let original = fixture.path("original");
    let node = fixture.path("node");
    let broker = fixture.path("broker.mjs");
    let state = fixture.path("production.json");
    executable(&original, "#!/bin/sh\nprintf 'original:%s\\n' \"$*\"\n");
    executable(
        &node,
        "#!/bin/sh\nprintf 'broker:%s:%s\\n' \"$STATEWRIGHT_DESKTOP_STATE_PATH\" \"$*\"\n",
    );
    fs::write(&broker, "// fixture\n").unwrap();
    fs::write(&state, "{}\n").unwrap();
    fs::write(
        fixture.path("launcher.conf"),
        format!(
            "version=1\noriginal_codex={}\nnode_executable={}\nbroker_script={}\nstate_path={}\n",
            original.display(),
            node.display(),
            broker.display(),
            state.display()
        ),
    )
    .unwrap();

    let foreign = fixture.path("foreign.conf");
    fs::write(&foreign, "version=1\noriginal_codex=/missing\nnode_executable=/missing\nbroker_script=/missing\nstate_path=/missing\n").unwrap();
    let server = Command::new(&launcher)
        .arg("app-server")
        .env("STATEWRIGHT_NATIVE_LAUNCHER_CONFIG", &foreign)
        .output()
        .unwrap();
    assert!(
        server.status.success(),
        "{}",
        String::from_utf8_lossy(&server.stderr)
    );
    assert_eq!(
        String::from_utf8(server.stdout).unwrap(),
        format!(
            "broker:{}:{} app-server\n",
            state.display(),
            broker.display()
        )
    );

    let ordinary = Command::new(&launcher)
        .args(["exec", "app-server"])
        .output()
        .unwrap();
    assert!(
        ordinary.status.success(),
        "{}",
        String::from_utf8_lossy(&ordinary.stderr)
    );
    assert_eq!(
        String::from_utf8(ordinary.stdout).unwrap(),
        "original:exec app-server\n"
    );
}
