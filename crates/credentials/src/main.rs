use serde::{Deserialize, Serialize};
use statewright_credentials::{
    CredentialError, CredentialStore, OsCredentialStore, account_for_gateway,
};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Request {
    operation: String,
    gateway: String,
    secret: Option<String>,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    status: String,
    account: String,
    secret: Option<String>,
    message: Option<String>,
}

fn error_response(account: String, error: CredentialError) -> Response {
    let (status, message) = match error {
        CredentialError::Missing => ("missing", None),
        CredentialError::InvalidGateway => (
            "invalid_gateway",
            Some("Gateway identity is invalid".into()),
        ),
        CredentialError::Unavailable(message) => ("unavailable", Some(message)),
    };
    Response {
        ok: false,
        status: status.into(),
        account,
        secret: None,
        message,
    }
}

fn process_request<S: CredentialStore>(request: Request, store: &S) -> Response {
    let account = match account_for_gateway(&request.gateway) {
        Ok(value) => value,
        Err(error) => return error_response(String::new(), error),
    };
    match request.operation.as_str() {
        "get" => match store.get(&account) {
            Ok(secret) => Response {
                ok: true,
                status: "ok".into(),
                account,
                secret: Some(secret),
                message: None,
            },
            Err(error) => error_response(account, error),
        },
        "set" => match request.secret.filter(|secret| !secret.trim().is_empty()) {
            Some(secret) => match store.set(&account, &secret) {
                Ok(()) => Response {
                    ok: true,
                    status: "ok".into(),
                    account,
                    secret: None,
                    message: None,
                },
                Err(error) => error_response(account, error),
            },
            None => Response {
                ok: false,
                status: "invalid_request".into(),
                account,
                secret: None,
                message: Some("Secret is required".into()),
            },
        },
        "delete" => match store.delete(&account) {
            Ok(()) => Response {
                ok: true,
                status: "ok".into(),
                account,
                secret: None,
                message: None,
            },
            Err(error) => error_response(account, error),
        },
        "status" => match store.get(&account) {
            Ok(_) => Response {
                ok: true,
                status: "configured".into(),
                account,
                secret: None,
                message: None,
            },
            Err(error) => error_response(account, error),
        },
        _ => Response {
            ok: false,
            status: "invalid_request".into(),
            account,
            secret: None,
            message: Some("Unknown operation".into()),
        },
    }
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() || input.len() > 16 * 1024 {
        std::process::exit(2);
    }
    let request: Request = match serde_json::from_str(&input) {
        Ok(value) => value,
        Err(_) => std::process::exit(2),
    };
    let response = process_request(request, &OsCredentialStore);
    println!("{}", serde_json::to_string(&response).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore(RefCell<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn get(&self, account: &str) -> Result<String, CredentialError> {
            self.0
                .borrow()
                .get(account)
                .cloned()
                .ok_or(CredentialError::Missing)
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
            self.0.borrow_mut().insert(account.into(), secret.into());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), CredentialError> {
            self.0
                .borrow_mut()
                .remove(account)
                .map(|_| ())
                .ok_or(CredentialError::Missing)
        }
    }

    fn request(operation: &str, gateway: &str, secret: Option<&str>) -> Request {
        Request {
            operation: operation.into(),
            gateway: gateway.into(),
            secret: secret.map(Into::into),
        }
    }

    #[test]
    fn stores_independent_credentials_by_gateway() {
        let store = MemoryStore::default();
        assert!(
            process_request(
                request("set", "https://prod.example", Some("prod-secret")),
                &store
            )
            .ok
        );
        assert!(
            process_request(
                request("set", "https://staging.example", Some("stage-secret")),
                &store
            )
            .ok
        );

        let prod = process_request(request("get", "https://prod.example/mcp", None), &store);
        let staging = process_request(request("get", "https://staging.example", None), &store);
        assert_eq!(prod.secret.as_deref(), Some("prod-secret"));
        assert_eq!(staging.secret.as_deref(), Some("stage-secret"));
        assert_ne!(prod.account, staging.account);
    }

    #[test]
    fn status_never_returns_the_secret() {
        let store = MemoryStore::default();
        process_request(
            request("set", "https://prod.example", Some("private")),
            &store,
        );
        let response = process_request(request("status", "https://prod.example", None), &store);
        assert!(response.ok);
        assert_eq!(response.status, "configured");
        assert!(response.secret.is_none());
    }
}
