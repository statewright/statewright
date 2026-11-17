//! Native classifier uncertainty reviews. The gateway alone mints and checks
//! receipts; a receipt never bypasses workflow admission or host permissions.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::HashMap;

const REVIEW_TTL_MS: i64 = 10 * 60 * 1000;
const ONCE_TTL_MS: i64 = 60 * 1000;
const MAX_REVIEWS: usize = 128;
const MAX_TOKENS: usize = 64;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn expires_at(value: Option<i64>) -> Value {
    value
        .and_then(|millis| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis))
        .map(|date| json!(date.to_rfc3339()))
        .unwrap_or(Value::Null)
}
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
fn id_hash(id: &str) -> String {
    crate::approval_memory::digest(&json!(id))
}

/// Empty or weak environment configuration disables reusable grants. Never
/// derive Debug or Serialize for secret key material.
pub(crate) struct GrantKey(Vec<u8>);
impl GrantKey {
    pub(crate) fn from_environment() -> Option<Self> {
        std::env::var("STATEWRIGHT_APPROVAL_GRANT_KEY")
            .ok()
            .and_then(|value| Self::parse(value.as_bytes()))
    }
    fn parse(value: &[u8]) -> Option<Self> {
        if value.len() < 32 {
            None
        } else {
            Some(Self(value.to_vec()))
        }
    }
    fn sign(&self, payload: &[u8]) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC key");
        mac.update(b"statewright/classifier-grant/v1.");
        mac.update(payload);
        mac.finalize().into_bytes().to_vec()
    }
    fn verify(&self, payload: &[u8], signature: &[u8]) -> bool {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC key");
        mac.update(b"statewright/classifier-grant/v1.");
        mac.update(payload);
        mac.verify_slice(signature).is_ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Binding {
    policy_sha256: String,
    invocation_sha256: String,
    dependency_sha256: String,
}
impl Binding {
    pub(crate) fn event_fields(&self) -> Value {
        json!({"policy_sha256":self.policy_sha256,"invocation_sha256":self.invocation_sha256,
            "dependency_sha256":self.dependency_sha256})
    }
    pub(crate) fn from_context(context: &Value) -> Option<Self> {
        let hash = |key: &str| {
            context
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .map(str::to_owned)
        };
        Some(Self {
            policy_sha256: hash("grant_policy_v2_sha256").or_else(|| hash("policy_sha256"))?,
            invocation_sha256: hash("invocation_sha256")?,
            dependency_sha256: hash("dependency_sha256")?,
        })
    }
}

#[derive(Clone)]
pub(crate) struct Review {
    pub(crate) id: String,
    pub(crate) owner: String,
    pub(crate) project: String,
    pub(crate) run: String,
    pub(crate) session: String,
    pub(crate) state: String,
    pub(crate) state_epoch: u64,
    pub(crate) generation: String,
    pub(crate) transition_count: u64,
    pub(crate) binding: Binding,
    pub(crate) policy_sha256: String,
    pub(crate) grant_policy_v2_sha256: Option<String>,
    pub(crate) invocation_fingerprint: Option<String>,
    pub(crate) allowed_durations: Vec<String>,
    pub(crate) default_duration: String,
    pub(crate) tool_name: String,
    pub(crate) tool_input: Value,
    pub(crate) issued_at_ms: i64,
    pub(crate) expires_at_ms: i64,
}
impl Review {
    pub(crate) fn new(
        owner: String,
        project: String,
        run: String,
        session: String,
        state: String,
        state_epoch: u64,
        generation: String,
        transition_count: u64,
        context: &Value,
        tool_name: &str,
        tool_input: &Value,
        reusable_key: bool,
    ) -> Option<Self> {
        let binding = Binding::from_context(context)?;
        let policy_sha256 = context["policy_sha256"]
            .as_str()
            .unwrap_or(&binding.policy_sha256)
            .to_owned();
        let grant_policy_v2_sha256 = context["grant_policy_v2_sha256"]
            .as_str()
            .map(str::to_owned);
        let reusable = context["reusable"] == true && reusable_key;
        let mut allowed_durations = vec!["once".to_owned()];
        if reusable {
            for item in context["allowed_durations"].as_array()? {
                let duration = item.as_str()?;
                if matches!(duration, "2h" | "4h" | "8h" | "always") {
                    allowed_durations.push(duration.to_owned());
                }
            }
        }
        let default_duration = context["approve_for"]
            .as_str()
            .filter(|value| allowed_durations.iter().any(|allowed| allowed == value))
            .unwrap_or("once")
            .to_owned();
        let issued_at_ms = now_ms();
        Some(Self {
            id: new_id(),
            owner,
            project,
            run,
            session,
            state,
            state_epoch,
            generation,
            transition_count,
            binding,
            policy_sha256,
            grant_policy_v2_sha256,
            invocation_fingerprint: None,
            allowed_durations,
            default_duration,
            tool_name: tool_name.into(),
            tool_input: tool_input.clone(),
            issued_at_ms,
            expires_at_ms: issued_at_ms + REVIEW_TTL_MS,
        })
    }
    pub(crate) fn memory_context(&self, context: &mut Value) {
        context["allowed_durations"] = json!(self.allowed_durations);
        context["approve_for"] = json!(self.default_duration);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    version: u8,
    grant_id: String,
    review_request_id: String,
    owner: String,
    project: String,
    binding: Binding,
    duration: String,
    issued_at_ms: i64,
    expires_at_ms: Option<i64>,
}
fn ttl(duration: &str) -> Option<i64> {
    match duration {
        "2h" => Some(2 * 60 * 60 * 1000),
        "4h" => Some(4 * 60 * 60 * 1000),
        "8h" => Some(8 * 60 * 60 * 1000),
        _ => None,
    }
}

pub(crate) struct GrantReceipt {
    pub(crate) payload: Value,
}

pub(crate) struct NativeProofs {
    pub(crate) tokens: Vec<String>,
    pub(crate) one_use_receipt: Option<String>,
    pub(crate) project_root: Option<String>,
}

pub(crate) struct ClassifierGrants {
    key: Option<GrantKey>,
    reviews: HashMap<String, Review>,
    once: HashMap<String, Review>,
}
impl ClassifierGrants {
    pub(crate) fn new(durable_history: bool) -> Self {
        Self {
            key: if durable_history {
                GrantKey::from_environment()
            } else {
                None
            },
            reviews: HashMap::new(),
            once: HashMap::new(),
        }
    }
    pub(crate) fn has_key(&self) -> bool {
        self.key.is_some()
    }
    fn prune(&mut self) {
        let now = now_ms();
        self.reviews.retain(|_, review| review.expires_at_ms > now);
        self.once.retain(|_, review| review.expires_at_ms > now);
    }
    pub(crate) fn issue(&mut self, review: Review) -> String {
        self.prune();
        if self.reviews.len() >= MAX_REVIEWS {
            if let Some(oldest) = self
                .reviews
                .values()
                .min_by_key(|review| review.issued_at_ms)
            {
                let id = oldest.id.clone();
                self.reviews.remove(&id);
            }
        }
        let id = review.id.clone();
        self.reviews.insert(id.clone(), review);
        id
    }
    /// Removal precedes validation, so a failed or concurrent mint cannot
    /// reuse the same human review decision.
    pub(crate) fn consume_review(&mut self, id: &str) -> Option<Review> {
        self.reviews
            .remove(id)
            .filter(|review| review.expires_at_ms > now_ms())
    }
    #[cfg(test)]
    pub(crate) fn change_dependency_for_test(&mut self, id: &str) {
        if let Some(review) = self.reviews.get_mut(id) {
            review.binding.dependency_sha256 = "f".repeat(64);
        }
    }
    pub(crate) fn grant(
        &mut self,
        review: Review,
        duration: &str,
    ) -> Result<GrantReceipt, &'static str> {
        if !review
            .allowed_durations
            .iter()
            .any(|allowed| allowed == duration)
        {
            return Err("Approval duration is outside workflow policy");
        }
        if duration != "once" && self.key.is_none() {
            return Err("Reusable approval key unavailable");
        }
        let grant_id = id_hash(&new_id());
        let immediate_receipt = new_id();
        let mut immediate = review.clone();
        immediate.expires_at_ms = now_ms() + ONCE_TTL_MS;
        self.once.insert(immediate_receipt.clone(), immediate);
        if duration == "once" {
            return Ok(GrantReceipt {
                payload: json!({"decision":"allow","classifier_approval":{
                "action":"granted","duration":"once","grant_id":grant_id,
                "expires_at":expires_at(Some(now_ms()+ONCE_TTL_MS)),"one_use_receipt":immediate_receipt}}),
            });
        }
        let Some(key) = self.key.as_ref() else {
            return Err("Reusable approval key unavailable");
        };
        let issued_at_ms = now_ms();
        let expires_at_ms = ttl(duration).map(|duration| issued_at_ms + duration);
        if duration != "always" && expires_at_ms.is_none() {
            return Err("Invalid approval duration");
        }
        let claims = Claims {
            version: 1,
            grant_id: grant_id.clone(),
            review_request_id: review.id,
            owner: review.owner,
            project: review.project,
            binding: review.binding,
            duration: duration.into(),
            issued_at_ms,
            expires_at_ms,
        };
        let body = serde_json::to_vec(&claims).expect("claims JSON");
        let token = format!(
            "v1.{}.{}",
            URL_SAFE_NO_PAD.encode(&body),
            URL_SAFE_NO_PAD.encode(key.sign(&body))
        );
        Ok(GrantReceipt {
            payload: json!({"decision":"allow","classifier_approval":{
            "action":"granted","duration":duration,"grant_id":grant_id,
            "expires_at":expires_at(expires_at_ms),"token":token,
            "one_use_receipt":immediate_receipt}}),
        })
    }
    pub(crate) fn use_once(
        &mut self,
        receipt: &str,
        owner: &str,
        project: &str,
        run: &str,
        session: &str,
        epoch: u64,
        binding: &Binding,
    ) -> Option<Value> {
        let review = self.once.remove(receipt)?;
        if review.expires_at_ms <= now_ms()
            || review.owner != owner
            || review.project != project
            || review.run != run
            || review.session != session
            || review.state_epoch != epoch
            || review.binding != *binding
        {
            return None;
        }
        Some(json!({"action":"consumed","duration":"once","review_request_id":review.id}))
    }
    pub(crate) fn reuse(
        &self,
        tokens: &[String],
        owner: &str,
        project: &str,
        binding: &Binding,
    ) -> Option<Value> {
        let key = self.key.as_ref()?;
        for token in tokens.iter().take(MAX_TOKENS) {
            if token.len() > 2048 {
                continue;
            }
            let Some(parts) = token.strip_prefix("v1.") else {
                continue;
            };
            let Some((body, signature)) = parts.split_once('.') else {
                continue;
            };
            let Ok(body) = URL_SAFE_NO_PAD.decode(body) else {
                continue;
            };
            let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
                continue;
            };
            if !key.verify(&body, &signature) {
                continue;
            }
            let Ok(claims) = serde_json::from_slice::<Claims>(&body) else {
                continue;
            };
            if claims.version != 1
                || claims.owner != owner
                || claims.project != project
                || claims.binding != *binding
                || claims.issued_at_ms > now_ms()
                || !matches!(claims.duration.as_str(), "2h" | "4h" | "8h" | "always")
                || claims
                    .expires_at_ms
                    .is_some_and(|expiry| expiry <= now_ms())
                || (claims.duration == "always") != claims.expires_at_ms.is_none()
                || (claims.duration != "always"
                    && claims.expires_at_ms
                        != ttl(&claims.duration).map(|ttl| claims.issued_at_ms + ttl))
            {
                continue;
            }
            return Some(json!({"action":"reused","duration":claims.duration,
                "grant_id":claims.grant_id,"review_request_id":claims.review_request_id,
                "expires_at":expires_at(claims.expires_at_ms)}));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(key: bool) -> (ClassifierGrants, Review) {
        let mut grants = ClassifierGrants::new(true);
        grants.key = key.then(|| GrantKey::parse(&[b'k'; 32]).unwrap());
        let context = json!({"grant_policy_v2_sha256":"a".repeat(64),"invocation_sha256":"b".repeat(64),
            "dependency_sha256":"c".repeat(64),"allowed_durations":["once","2h","4h","8h","always"],
            "approve_for":"4h","reusable":true});
        let review = Review::new(
            "owner".into(),
            "project".into(),
            "run".into(),
            "session".into(),
            "state".into(),
            1,
            "generation".into(),
            0,
            &context,
            "Bash",
            &json!({"command":"x"}),
            key,
        )
        .unwrap();
        (grants, review)
    }
    #[test]
    fn review_is_one_time_and_expiring() {
        let (mut grants, review) = fixture(true);
        let id = grants.issue(review.clone());
        assert!(grants.consume_review(&id).is_some());
        assert!(grants.consume_review(&id).is_none());
        let mut expired = review;
        expired.expires_at_ms = now_ms() - 1;
        let id = grants.issue(expired);
        assert!(grants.consume_review(&id).is_none());
    }
    #[test]
    fn signed_durations_tamper_expiry_binding_and_missing_key() {
        for duration in ["2h", "4h", "8h", "always"] {
            let (mut grants, review) = fixture(true);
            let receipt = grants.grant(review.clone(), duration).unwrap().payload;
            let token = receipt["classifier_approval"]["token"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_eq!(
                receipt["classifier_approval"]["expires_at"].is_null(),
                duration == "always"
            );
            assert_eq!(
                grants
                    .reuse(&[token.clone()], "owner", "project", &review.binding)
                    .unwrap()["duration"],
                duration
            );
            assert!(
                grants
                    .reuse(&[token.clone()], "foreign", "project", &review.binding)
                    .is_none()
            );
            assert!(
                grants
                    .reuse(&[token.clone()], "owner", "foreign", &review.binding)
                    .is_none()
            );
            let mut wrong = review.binding.clone();
            wrong.dependency_sha256 = "d".repeat(64);
            assert!(
                grants
                    .reuse(&[token.clone()], "owner", "project", &wrong)
                    .is_none()
            );
            wrong = review.binding.clone();
            wrong.policy_sha256 = "d".repeat(64);
            assert!(
                grants
                    .reuse(&[token.clone()], "owner", "project", &wrong)
                    .is_none()
            );
            let mut tampered = token.into_bytes();
            let last = tampered.len() - 1;
            tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
            assert!(
                grants
                    .reuse(
                        &[String::from_utf8(tampered).unwrap()],
                        "owner",
                        "project",
                        &review.binding
                    )
                    .is_none()
            );
            if duration != "always" {
                let expiry = ttl(duration).unwrap();
                let claims = Claims {
                    version: 1,
                    grant_id: "expired".into(),
                    review_request_id: "review".into(),
                    owner: "owner".into(),
                    project: "project".into(),
                    binding: review.binding.clone(),
                    duration: duration.into(),
                    issued_at_ms: now_ms() - expiry - 1,
                    expires_at_ms: Some(now_ms() - 1),
                };
                let body = serde_json::to_vec(&claims).unwrap();
                let key = grants.key.as_ref().unwrap();
                let token = format!(
                    "v1.{}.{}",
                    URL_SAFE_NO_PAD.encode(&body),
                    URL_SAFE_NO_PAD.encode(key.sign(&body))
                );
                assert!(
                    grants
                        .reuse(&[token], "owner", "project", &review.binding)
                        .is_none()
                );
            }
        }
        let (mut grants, review) = fixture(false);
        assert_eq!(review.allowed_durations, vec!["once"]);
        assert!(grants.grant(review.clone(), "4h").is_err());
        assert!(grants.grant(review, "once").is_ok());
    }
    #[test]
    fn incomplete_provenance_is_once_only_even_with_key() {
        let (mut grants, _) = fixture(true);
        let context = json!({"grant_policy_v2_sha256":"a".repeat(64),
            "invocation_sha256":"b".repeat(64),"dependency_sha256":"c".repeat(64),
            "allowed_durations":["once","2h","4h","8h","always"],
            "approve_for":"4h","reusable":false});
        let review = Review::new(
            "owner".into(),
            "project".into(),
            "run".into(),
            "session".into(),
            "state".into(),
            1,
            "generation".into(),
            0,
            &context,
            "Bash",
            &json!({"command":"x"}),
            true,
        )
        .unwrap();
        assert_eq!(review.allowed_durations, vec!["once"]);
        assert_eq!(review.default_duration, "once");
        assert!(grants.grant(review.clone(), "4h").is_err());
        assert!(grants.grant(review, "once").is_ok());
    }
}
