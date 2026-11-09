//! Durable, privacy-bounded native audit receipts and simulation intake.
//! The server provisions the root; workflow metadata cannot choose its path.

use crate::classifier_audit::AuditReceipt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SimulationCase {
    tool_name: ToolName,
    command_shape: Vec<CommandShape>,
}

#[derive(Debug, Deserialize, Serialize)]
enum ToolName {
    Bash,
    #[serde(rename = "bash")]
    LowerBash,
    #[serde(rename = "shell")]
    Shell,
    #[serde(rename = "exec_command")]
    ExecCommand,
    #[serde(rename = "functions.exec_command")]
    FunctionsExecCommand,
    #[serde(rename = "mcp")]
    Mcp,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommandShape {
    executable: CommandFamily,
    effect: Effect,
    delegates_unknown_effect: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CommandFamily {
    Git,
    Cargo,
    Npm,
    Node,
    Python,
    Sed,
    Awk,
    Rg,
    Grep,
    Find,
    Cat,
    Head,
    Tail,
    Sort,
    Uniq,
    Cut,
    Tr,
    Wc,
    Curl,
    Wget,
    Ssh,
    Shell,
    Other,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Effect {
    Unknown,
    ExternalUnknown,
    Destructive,
    RestrictedExternal,
    OtherKnownEffect,
    Read,
    Write,
    Execute,
    Output,
}

/// A local queue reference, never an execution or approval token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PersistedAuditReference {
    pub file_name: String,
    pub sha256: String,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Commit one envelope containing both receipt and unlabelled simulation case.
/// Success requires synced file contents and directory entries. The root must
/// already exist, must not be a symlink, and on Unix must disallow group/other
/// access. Ancestors and filesystem durability are deployment responsibilities.
/// Unsupported platforms fail rather than promise nonexistent mode semantics.
pub fn persist(
    root: &Path,
    receipt: &AuditReceipt,
    case: &serde_json::Value,
) -> io::Result<PersistedAuditReference> {
    let raw_size = serde_json::to_vec(case)
        .map_err(|_| invalid("invalid simulation metadata"))?
        .len();
    if raw_size > 16 * 1024 {
        return Err(invalid("simulation metadata exceeds size bound"));
    }
    let case: SimulationCase = serde_json::from_value(case.clone())
        .map_err(|_| invalid("simulation metadata must match closed structural schema"))?;
    if case.command_shape.len() > 32 {
        return Err(invalid("simulation metadata exceeds shape bound"));
    }
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("audit root must be an existing private directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid("audit root must disallow group and other access"));
        }
    }
    #[cfg(not(unix))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "private audit store requires Unix permissions",
    ));

    let id = uuid::Uuid::new_v4().to_string();
    let envelope = serde_json::json!({
        "schema_version": 1,
        "record_type": "classifier_audit_simulation_intake",
        "id": id,
        "label": null,
        "status": "unlabelled_pending_review",
        "replay_ready": false,
        "receipt": receipt,
        "case": case,
    });
    let bytes =
        serde_json::to_vec(&envelope).map_err(|_| invalid("cannot serialize audit envelope"))?;
    let reference = PersistedAuditReference {
        file_name: format!("audit-{id}.json"),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
    };
    let temporary = root.join(format!("audit-{id}.pending"));
    let final_path = root.join(&reference.file_name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Hard-link publication is atomic and never replaces an existing file.
        // Pending files are ignored by ingestion after a crash.
        fs::hard_link(&temporary, &final_path)?;
        fs::File::open(root)?.sync_all()?;
        fs::remove_file(&temporary)?;
        fs::File::open(root)?.sync_all()?;
        Ok(reference)
    })();
    if result.is_err() {
        // Only our exact newly created pending file is eligible for cleanup.
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::classifier_audit::{
        self, AuditAction, AuditConfig, AuditEvidenceReferences, ClassifierOutcome, EvidenceDigest,
        IndependentGuards, NativePermissions,
    };
    use std::os::unix::fs::PermissionsExt;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("statewright-audit-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn receipt() -> AuditReceipt {
        let digest = EvidenceDigest::new(&"a".repeat(64)).unwrap();
        let evidence = AuditEvidenceReferences {
            workflow: digest.clone(),
            policy: digest.clone(),
            invocation: digest.clone(),
            classifier_decision: digest.clone(),
            independent_guards: digest.clone(),
            native_context: digest,
        };
        let config =
            AuditConfig::from_metadata(Some(&serde_json::json!({"mode":"audit"})), Some("staging"))
                .unwrap();
        let guards = IndependentGuards {
            workflow_tool: true,
            interceptor: true,
            capability: true,
            scope: true,
            native_approval: NativePermissions::DeferredToHost,
            human_review: true,
        };
        let AuditAction::RecordBeforeProceeding(receipt) =
            classifier_audit::evaluate(config, ClassifierOutcome::DenyUncertain, guards, evidence)
        else {
            panic!("expected receipt")
        };
        receipt
    }
    fn case() -> serde_json::Value {
        serde_json::json!({"tool_name":"Bash", "command_shape":[{
            "executable":"other", "effect":"unknown", "delegates_unknown_effect":true}]})
    }

    #[test]
    fn persists_private_unique_unlabelled_combined_envelope() {
        let root = Fixture::new();
        let first = persist(&root.0, &receipt(), &case()).unwrap();
        let second = persist(&root.0, &receipt(), &case()).unwrap();
        assert_ne!(first.file_name, second.file_name);
        let bytes = fs::read(root.0.join(&first.file_name)).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), first.sha256);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["label"].is_null());
        assert_eq!(value["status"], "unlabelled_pending_review");
        assert_eq!(value["replay_ready"], false);
        assert_eq!(
            value["receipt"]["event"],
            "classifier_would_block_uncertain"
        );
        assert_eq!(
            fs::metadata(root.0.join(first.file_name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn rejects_raw_strings_extra_fields_oversized_and_malformed_shapes() {
        let root = Fixture::new();
        let mut extra = case();
        extra["command"] = "curl -H secret".into();
        let mut executable = case();
        executable["command_shape"][0]["executable"] = "credential-value".into();
        let mut tool = case();
        tool["tool_name"] = "credential-value".into();
        let mut shape = case();
        shape["command_shape"][0]["argv"] = serde_json::json!(["secret"]);
        let mut many = case();
        many["command_shape"] = serde_json::json!(vec![case()["command_shape"][0].clone(); 33]);
        for input in [
            extra,
            executable,
            tool,
            shape,
            many,
            serde_json::json!(null),
            serde_json::json!({"tool_name":"other", "command_shape":"secret"}),
            serde_json::json!({"tool_name":"other", "command_shape":[], "raw":"x".repeat(17000)}),
        ] {
            assert!(persist(&root.0, &receipt(), &input).is_err());
        }
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn storage_failures_and_insecure_or_symlink_roots_fail_closed() {
        let root = Fixture::new();
        assert!(persist(&root.0.join("absent"), &receipt(), &case()).is_err());
        let file = root.0.join("file");
        fs::write(&file, b"existing").unwrap();
        assert!(persist(&file, &receipt(), &case()).is_err());
        let link = root.0.join("link");
        std::os::unix::fs::symlink(&root.0, &link).unwrap();
        assert!(persist(&link, &receipt(), &case()).is_err());
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(persist(&root.0, &receipt(), &case()).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"existing");
    }
}
