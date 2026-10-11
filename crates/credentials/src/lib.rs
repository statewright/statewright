use sha2::{Digest, Sha256};

pub const SERVICE: &str = "ai.statewright.gateway";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    InvalidGateway,
    Missing,
    Unavailable(String),
}

pub trait CredentialStore {
    fn get(&self, account: &str) -> Result<String, CredentialError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), CredentialError>;
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
}

pub fn canonical_gateway(value: &str) -> Result<String, CredentialError> {
    let mut url = url::Url::parse(value).map_err(|_| CredentialError::InvalidGateway)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CredentialError::InvalidGateway);
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/mcp") {
        path.to_string()
    } else {
        format!("{path}/mcp")
    };
    url.set_path(&path);
    Ok(url.to_string())
}

pub fn account_for_gateway(gateway: &str) -> Result<String, CredentialError> {
    let canonical = canonical_gateway(gateway)?;
    let hash = Sha256::digest(canonical.as_bytes());
    Ok(format!("v1:{hash:x}"))
}

pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(account: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|_| CredentialError::Unavailable("OS credential store is unavailable".into()))
    }
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, account: &str) -> Result<String, CredentialError> {
        Self::entry(account)?.get_password().map_err(|error| {
            if matches!(error, keyring::Error::NoEntry) {
                CredentialError::Missing
            } else {
                CredentialError::Unavailable(
                    "OS credential store could not read this gateway credential".into(),
                )
            }
        })
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        Self::entry(account)?.set_password(secret).map_err(|_| {
            CredentialError::Unavailable(
                "OS credential store could not save this gateway credential".into(),
            )
        })
    }
    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        Self::entry(account)?.delete_credential().map_err(|error| {
            if matches!(error, keyring::Error::NoEntry) {
                CredentialError::Missing
            } else {
                CredentialError::Unavailable(
                    "OS credential store could not remove this gateway credential".into(),
                )
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_gateway_aliases() {
        assert_eq!(
            canonical_gateway("https://MCP.STATEWRIGHT.AI"),
            canonical_gateway("https://mcp.statewright.ai/mcp/")
        );
        assert_ne!(
            account_for_gateway("https://one.example"),
            account_for_gateway("https://two.example")
        );
    }

    #[test]
    fn preserves_meaningful_gateway_identity() {
        assert_ne!(
            account_for_gateway("https://example.test/team-a"),
            account_for_gateway("https://example.test/team-b")
        );
        assert_ne!(
            account_for_gateway("https://example.test:8443"),
            account_for_gateway("https://example.test")
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsafe_gateway_values() {
        for value in [
            "file:///tmp/socket",
            "https://user@example.test",
            "https://example.test?tenant=a",
            "https://example.test/#fragment",
        ] {
            assert_eq!(
                canonical_gateway(value),
                Err(CredentialError::InvalidGateway)
            );
        }
    }
}
