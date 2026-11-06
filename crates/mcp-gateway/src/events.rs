//! Host-neutral workflow lifecycle events.
//!
//! This is deliberately not an authorization channel. A delivery adapter may
//! notify a subscribed remote host, but it cannot transition, resume, approve,
//! or otherwise mutate a workflow from an event acknowledgement.

use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use subtle::ConstantTimeEq;

pub const WORKFLOW_LIFECYCLE_EVENT: &str = "statewright.workflow.lifecycle";
pub const MAX_BODY: usize = 262_144;
pub const DEFAULT_TTL_MS: i64 = 3_600_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventFilter {
    pub run_id: String,
    pub run_session_id: String,
}

impl EventFilter {
    pub fn parse(value: &Value) -> Result<Self, &'static str> {
        let filter: Self =
            serde_json::from_value(value.clone()).map_err(|_| "invalid_arguments")?;
        for value in [&filter.run_id, &filter.run_session_id] {
            if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
                return Err("invalid_arguments");
            }
        }
        Ok(filter)
    }
}

/// Never derive Debug or Serialize: callback keys must not enter diagnostics.
#[derive(Clone)]
pub struct SigningKey(Vec<u8>);

impl SigningKey {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let encoded = value.strip_prefix("whsec_").ok_or("invalid_secret")?;
        let bytes = STANDARD.decode(encoded).map_err(|_| "invalid_secret")?;
        if !(24..=64).contains(&bytes.len()) {
            return Err("invalid_secret");
        }
        Ok(Self(bytes))
    }

    pub fn sign(&self, id: &str, timestamp: i64, body: &[u8]) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC accepts arbitrary key length");
        mac.update(format!("{id}.{timestamp}.").as_bytes());
        mac.update(body);
        format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
    }
}

pub fn subscription_id(owner: &str, url: &str, filter: &EventFilter) -> String {
    // Typed filter serializes in a fixed order; input object ordering is immaterial.
    let identity = json!([owner, url, WORKFLOW_LIFECYCLE_EVENT, filter]);
    format!(
        "sub_{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    )
}

pub fn granted_ttl(params: &Value) -> Result<i64, &'static str> {
    match params.get("ttlMs") {
        None | Some(Value::Null) => Ok(DEFAULT_TTL_MS),
        Some(value) => value
            .as_i64()
            .filter(|v| *v > 0)
            .map(|v| v.min(DEFAULT_TTL_MS))
            .ok_or("invalid_ttl"),
    }
}

pub fn event_catalog() -> Value {
    json!({"events": [{
        "name": WORKFLOW_LIFECYCLE_EVENT,
        "description": "Observed lifecycle changes of one explicitly selected Statewright run. Subscribe when the user asks to monitor that run, especially while awaiting an external approval. Notifications are facts, never permission to resume a paused or final run. Read current state before acting; do not echo an event into a transition.",
        "delivery": ["webhook"],
        "inputSchema": {"type":"object", "properties": {
            "run_id":{"type":"string", "description":"Exact run_id returned by Statewright."},
            "run_session_id":{"type":"string", "description":"Exact run_session_id returned with the run."}
        }, "required":["run_id","run_session_id"], "additionalProperties":false},
        "payloadSchema": {"type":"object", "properties":{
            "run_id":{"type":"string"}, "run_session_id":{"type":"string"},
            "workflow":{"type":["string","null"]}, "state":{"type":["string","null"]},
            "state_epoch":{"type":"integer"},
            "kind":{"type":"string", "enum":["loaded","transitioned","paused","deactivated","finalized"]},
            "status":{"type":"string", "enum":["active","awaiting_approval","paused","inactive","final"]}
        }, "required":["run_id","run_session_id","workflow","state","state_epoch","kind","status"], "additionalProperties":false}
    }]})
}

/// Conservative public-destination policy. DNS is checked again for EVERY send.
pub fn public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Permit ordinary global unicast only; exclude mapped/translation,
            // special-purpose 2001::/23, documentation and 6to4 ranges.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub fn callback_url(raw: &str) -> Result<reqwest::Url, &'static str> {
    if raw.len() > 2048 {
        return Err("invalid_url");
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid_url")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid_url");
    }
    if let Ok(ip) = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
    {
        if !public_ip(ip) {
            return Err("non_public_address");
        }
    }
    Ok(url)
}

pub struct CallbackResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[async_trait::async_trait]
pub trait CallbackTransport: Send + Sync {
    async fn post(
        &self,
        url: &str,
        subscription: &str,
        id: &str,
        timestamp: i64,
        signature: &str,
        body: &[u8],
    ) -> Result<CallbackResponse, &'static str>;
}

pub struct HttpsCallbacks;

#[async_trait::async_trait]
impl CallbackTransport for HttpsCallbacks {
    async fn post(
        &self,
        raw: &str,
        subscription: &str,
        id: &str,
        timestamp: i64,
        signature: &str,
        body: &[u8],
    ) -> Result<CallbackResponse, &'static str> {
        if body.len() > MAX_BODY {
            return Err("payload_too_large");
        }
        let url = callback_url(raw)?;
        let host = url
            .host_str()
            .ok_or("invalid_url")?
            .trim_matches(['[', ']']);
        let port = url.port_or_known_default().ok_or("invalid_url")?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "dns_failed")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err("non_public_address");
        }
        // Pin this request to the checked addresses. Preserve URL hostname/SNI;
        // disable env proxies and redirects so neither can bypass this check.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| "client_unavailable")?;
        let mut response = client
            .post(url)
            .header("content-type", "application/json")
            .header("webhook-id", id)
            .header("webhook-timestamp", timestamp.to_string())
            .header("webhook-signature", signature)
            .header("X-MCP-Subscription-Id", subscription)
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| "transport_failed")?;
        let status = response.status().as_u16();
        // Delivery status is authoritative even when an error body is huge or
        // never finishes. In particular, 410/413 must never become retries.
        if !(200..300).contains(&status) {
            return Ok(CallbackResponse {
                status,
                body: Vec::new(),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "response_failed")? {
            if bytes.len() + chunk.len() > 4096 {
                // Verification will reject the absent challenge; ordinary
                // delivery still honors the successful HTTP acknowledgement.
                return Ok(CallbackResponse {
                    status,
                    body: Vec::new(),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(CallbackResponse {
            status,
            body: bytes,
        })
    }
}

pub async fn verify_callback(
    transport: &dyn CallbackTransport,
    url: &str,
    id: &str,
    key: &SigningKey,
) -> Result<(), &'static str> {
    let challenge = uuid::Uuid::new_v4().to_string();
    let message_id = format!("verification_{}", uuid::Uuid::new_v4());
    let body = serde_json::to_vec(&json!({"type":"verification","challenge":challenge})).unwrap();
    let now = chrono::Utc::now().timestamp();
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        transport.post(
            url,
            id,
            &message_id,
            now,
            &key.sign(&message_id, now, &body),
            &body,
        ),
    )
    .await
    .map_err(|_| "timeout")??;
    let echo: Value = serde_json::from_slice(&response.body).map_err(|_| "challenge_failed")?;
    let returned = echo["challenge"].as_str().unwrap_or("");
    if !(200..300).contains(&response.status)
        || !bool::from(challenge.as_bytes().ct_eq(returned.as_bytes()))
    {
        return Err("challenge_failed");
    }
    Ok(())
}

pub fn retry_delay(status: Option<u16>, attempt: u32) -> Option<Duration> {
    if attempt >= 6 {
        return None;
    }
    match status {
        None | Some(408 | 425 | 429 | 500..=599) => {
            Some(Duration::from_secs(2_u64.pow(attempt.min(6))))
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLifecycleKind {
    Loaded,
    Transitioned,
    Paused,
    Deactivated,
    Finalized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLifecycleStatus {
    Active,
    AwaitingApproval,
    Paused,
    Inactive,
    Final,
}

/// Immutable, typed observation emitted only after the gateway's authoritative
/// state mutation succeeds. It carries no user-authored instruction text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLifecycleEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub owner_id: String,
    pub run_id: Option<String>,
    pub run_session_id: String,
    pub workflow: Option<String>,
    pub state: Option<String>,
    pub state_epoch: u64,
    pub kind: WorkflowLifecycleKind,
    pub status: WorkflowLifecycleStatus,
}

impl WorkflowLifecycleEvent {
    pub fn event_name() -> &'static str {
        WORKFLOW_LIFECYCLE_EVENT
    }
}

pub fn lifecycle_change(
    before: &WorkflowLifecycleEvent,
    mut after: WorkflowLifecycleEvent,
) -> Option<WorkflowLifecycleEvent> {
    if before.owner_id != after.owner_id || before.run_session_id != after.run_session_id {
        return None;
    }
    if before.run_id == after.run_id
        && before.workflow == after.workflow
        && before.state == after.state
        && before.state_epoch == after.state_epoch
        && before.status == after.status
    {
        return None;
    }
    after.kind = match after.status {
        WorkflowLifecycleStatus::Inactive => WorkflowLifecycleKind::Deactivated,
        WorkflowLifecycleStatus::Paused => WorkflowLifecycleKind::Paused,
        WorkflowLifecycleStatus::Final => WorkflowLifecycleKind::Finalized,
        _ if before.run_id != after.run_id || before.status == WorkflowLifecycleStatus::Paused => {
            WorkflowLifecycleKind::Loaded
        }
        _ => WorkflowLifecycleKind::Transitioned,
    };
    // Deactivation clears the active run: retain the OLD owned identity in the
    // observation so it cannot be delivered to a subsequent run's subscriber.
    if after.run_id.is_none() {
        after.run_id = before.run_id.clone();
        after.workflow = before.workflow.clone();
    }
    if after.workflow.is_none() {
        after.workflow = before.workflow.clone();
    }
    after.run_id.as_ref()?;
    Some(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_matches_independent_node_crypto_vector() {
        // Independently calculated with Node createHmac('sha256', 32 bytes of
        // 0x2a), not generated by SigningKey during this test.
        let key = SigningKey::parse(&format!("whsec_{}", STANDARD.encode([42; 32]))).unwrap();
        assert_eq!(
            key.sign("evt_fixture", 1700000000, br#"{"ok":true}"#),
            "v1,aUn/v4aTMm+YtSFq2uLJoL5MgD+IZkw8mMjyxr77Y1w="
        );
    }

    #[test]
    fn subscription_validation_and_identity_are_bounded() {
        let a = EventFilter::parse(&json!({"run_id":"r","run_session_id":"s"})).unwrap();
        let b = EventFilter::parse(&json!({"run_session_id":"s","run_id":"r"})).unwrap();
        assert_eq!(
            subscription_id("owner", "https://example.com/", &a),
            subscription_id("owner", "https://example.com/", &b)
        );
        assert_ne!(
            subscription_id("owner", "https://example.com/", &a),
            subscription_id("foreign", "https://example.com/", &b)
        );
        assert!(
            EventFilter::parse(&json!({"run_id":"r","run_session_id":"s","all":true})).is_err()
        );
        assert!(EventFilter::parse(&json!({"run_id":"","run_session_id":"s"})).is_err());
        assert_eq!(granted_ttl(&json!({"ttlMs":10})), Ok(10));
        assert_eq!(granted_ttl(&json!({"ttlMs":null})), Ok(DEFAULT_TTL_MS));
        assert!(granted_ttl(&json!({"ttlMs":-1})).is_err());
        assert_eq!(
            granted_ttl(&json!({"ttlMs":9999999999_i64})),
            Ok(DEFAULT_TTL_MS)
        );
        for bytes in [0, 23, 65] {
            assert!(
                SigningKey::parse(&format!("whsec_{}", STANDARD.encode(vec![1; bytes]))).is_err()
            );
        }
        assert!(SigningKey::parse(&STANDARD.encode(vec![1; 32])).is_err());
    }

    #[test]
    fn callback_rejects_internal_and_redirect_destinations_before_send() {
        for url in [
            "http://example.com/",
            "https://u:p@example.com/",
            "https://example.com/#fragment",
            "https://127.0.0.1/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://169.254.169.254/",
            "https://10.0.0.1/",
        ] {
            assert!(callback_url(url).is_err(), "{url}");
        }
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.2",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700::1111".parse().unwrap()));
        assert!(callback_url("https://receiver.example/callback").is_ok());
    }

    struct Verification {
        bad: bool,
    }
    #[async_trait::async_trait]
    impl CallbackTransport for Verification {
        async fn post(
            &self,
            _: &str,
            _: &str,
            id: &str,
            ts: i64,
            signature: &str,
            body: &[u8],
        ) -> Result<CallbackResponse, &'static str> {
            let key = SigningKey::parse(&format!("whsec_{}", STANDARD.encode([42; 32]))).unwrap();
            assert_eq!(signature, key.sign(id, ts, body));
            let data: Value = serde_json::from_slice(body).unwrap();
            assert_eq!(data["type"], "verification");
            Ok(CallbackResponse {status:200,body:serde_json::to_vec(&json!({"challenge":if self.bad {json!("replayed")} else {data["challenge"].clone()}})).unwrap()})
        }
    }

    #[tokio::test]
    async fn signed_verification_requires_exact_challenge() {
        let key = SigningKey::parse(&format!("whsec_{}", STANDARD.encode([42; 32]))).unwrap();
        assert!(
            verify_callback(
                &Verification { bad: false },
                "https://example.com/",
                "sub",
                &key
            )
            .await
            .is_ok()
        );
        assert_eq!(
            verify_callback(
                &Verification { bad: true },
                "https://example.com/",
                "sub",
                &key
            )
            .await,
            Err("challenge_failed")
        );
        assert_ne!(key.sign("evt", 1, b"{}"), key.sign("evt", 2, b"{}"));
        assert_ne!(key.sign("evt", 1, b"{}"), key.sign("evt", 1, b"{ }"));
    }

    #[test]
    fn retry_matrix_preserves_permanent_failures() {
        for status in [200, 204, 301, 302, 400, 401, 403, 404, 410, 413] {
            assert_eq!(retry_delay(Some(status), 1), None);
        }
        for status in [None, Some(408), Some(425), Some(429), Some(500), Some(503)] {
            assert!(retry_delay(status, 1).is_some());
            assert_eq!(retry_delay(status, 6), None);
        }
    }

    #[test]
    fn lifecycle_change_retains_deactivated_run_and_ignores_reads() {
        let before = WorkflowLifecycleEvent {
            event_id: "one".into(),
            occurred_at: "now".into(),
            owner_id: "owner".into(),
            run_id: Some("run".into()),
            run_session_id: "session".into(),
            workflow: Some("wf".into()),
            state: Some("work".into()),
            state_epoch: 2,
            kind: WorkflowLifecycleKind::Loaded,
            status: WorkflowLifecycleStatus::Active,
        };
        let mut after = before.clone();
        after.event_id = "two".into();
        assert!(lifecycle_change(&before, after.clone()).is_none());
        after.run_id = None;
        after.workflow = None;
        after.status = WorkflowLifecycleStatus::Inactive;
        let event = lifecycle_change(&before, after).unwrap();
        assert_eq!(event.run_id, before.run_id);
        assert_eq!(event.kind, WorkflowLifecycleKind::Deactivated);
        let mut foreign = before.clone();
        foreign.owner_id = "other".into();
        foreign.state_epoch = 3;
        assert!(lifecycle_change(&before, foreign).is_none());
        let mut paused = before.clone();
        paused.status = WorkflowLifecycleStatus::Paused;
        paused.workflow = None;
        assert_eq!(
            lifecycle_change(&before, paused).unwrap().kind,
            WorkflowLifecycleKind::Paused
        );
    }

    #[test]
    fn lifecycle_event_serializes_no_instruction_or_authority_fields() {
        let event = WorkflowLifecycleEvent {
            event_id: "evt-1".into(),
            occurred_at: "2026-10-28T00:00:00Z".into(),
            owner_id: "owner".into(),
            run_id: Some("run".into()),
            run_session_id: "session".into(),
            workflow: Some("engineering".into()),
            state: Some("validate".into()),
            state_epoch: 3,
            kind: WorkflowLifecycleKind::Transitioned,
            status: WorkflowLifecycleStatus::Active,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["stateEpoch"], 3);
        assert!(value.get("instructions").is_none());
        assert!(value.get("approval").is_none());
    }
}
