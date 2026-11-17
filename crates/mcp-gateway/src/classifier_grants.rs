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
const MAX_ONCE: usize = 128;
const MAX_TOKENS: usize = 64;
/// Revocation scopes are never evicted (eviction would revive revoked
/// tokens). At capacity a new scope's revoke fails loudly instead.
const MAX_REVOCATION_SCOPES: usize = 65_536;

/// Process-local revocation cutoffs keyed by (owner, project scope). With
/// durable history the gateway also persists each cutoff in Postgres and reads
/// it back on reuse, so restarts and other replicas honour it; this map is the
/// authoritative store only when there is no database (and therefore no
/// reusable-grant key), which in practice means tests.
static REVOCATIONS: std::sync::OnceLock<std::sync::Mutex<HashMap<(String, String), i64>>> =
    std::sync::OnceLock::new();
fn revocations() -> std::sync::MutexGuard<'static, HashMap<(String, String), i64>> {
    REVOCATIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
/// Record that every reusable grant issued at or before `at_ms` for this
/// owner/project is revoked. Returns false only when a new scope cannot be
/// tracked.
pub(crate) fn record_revocation(owner: &str, project: &str, at_ms: i64) -> bool {
    let mut map = revocations();
    let key = (owner.to_owned(), project.to_owned());
    if !map.contains_key(&key) && map.len() >= MAX_REVOCATION_SCOPES {
        return false;
    }
    let entry = map.entry(key).or_insert(at_ms);
    *entry = (*entry).max(at_ms);
    true
}
pub(crate) fn local_revoked_before(owner: &str, project: &str) -> Option<i64> {
    revocations()
        .get(&(owner.to_owned(), project.to_owned()))
        .copied()
}
pub(crate) fn current_ms() -> i64 {
    now_ms()
}

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
    pub(crate) fn matches_invocation_hash(&self, hash: &str) -> bool {
        self.invocation_sha256 == hash
    }
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
    pub(crate) host_cwd: Option<String>,
    /// Gateway-issued MCP transport session (`Mcp-Session-Id`) the review was
    /// issued on. Grants and outcomes must arrive on the same transport.
    pub(crate) transport: Option<String>,
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
        host_cwd: Option<&str>,
        reusable_key: bool,
        allow_always: bool,
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
                if matches!(duration, "2h" | "4h" | "8h" | "always")
                    && (duration != "always" || (allow_always && crate::approval_memory::always_enabled())) {
                    allowed_durations.push(duration.to_owned());
                }
            }
        }
        let default_duration = context["approve_for"]
            .as_str()
            .filter(|value| *value != "always" && allowed_durations.iter().any(|allowed| allowed == value))
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
            host_cwd: host_cwd.map(str::to_owned),
            transport: None,
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
    pub(crate) host_cwd: Option<String>,
}

pub(crate) struct ClassifierGrants {
    key: Option<GrantKey>,
    always_enabled: bool,
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
            always_enabled: crate::approval_memory::always_enabled(),
            reviews: HashMap::new(),
            once: HashMap::new(),
        }
    }
    pub(crate) fn has_key(&self) -> bool {
        self.key.is_some()
    }
    pub(crate) fn always_available(&self) -> bool {
        self.always_enabled && crate::approval_memory::always_enabled()
    }
    #[cfg(test)]
    pub(crate) fn enable_key_for_test(&mut self) {
        self.key = GrantKey::parse(&[b'k'; 32]);
    }
    #[cfg(test)]
    pub(crate) fn disable_always_for_test(&mut self) {
        self.always_enabled = false;
    }
    fn prune(&mut self) {
        let now = now_ms();
        self.reviews.retain(|_, review| review.expires_at_ms > now);
        self.once.retain(|_, review| review.expires_at_ms > now);
    }
    pub(crate) fn issue(&mut self, review: Review) -> Option<String> {
        self.prune();
        // A review that is not bound to a verified MCP transport could be
        // answered by any holder of the same OAuth credential. Issue nothing.
        if review.transport.as_deref().is_none_or(str::is_empty) {
            return None;
        }
        if self.reviews.len() >= MAX_REVIEWS {
            // Expired entries have already been swept. Never discard a live,
            // unconsumed human decision to admit another request.
            return None;
        }
        let id = review.id.clone();
        self.reviews.insert(id.clone(), review);
        Some(id)
    }
    /// Removal precedes validation, so a failed or concurrent mint cannot
    /// reuse the same human review decision.
    pub(crate) fn consume_review(&mut self, id: &str) -> Option<Review> {
        self.prune();
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
    #[cfg(test)]
    pub(crate) fn change_invocation_for_test(&mut self, id: &str) {
        if let Some(review) = self.reviews.get_mut(id) {
            review.binding.invocation_sha256 = "f".repeat(64);
        }
    }
    #[cfg(test)]
    pub(crate) fn expire_review_for_test(&mut self, id: &str) {
        if let Some(review) = self.reviews.get_mut(id) {
            review.expires_at_ms = now_ms() - 1;
        }
    }
    #[cfg(test)]
    pub(crate) fn pending_receipt_count_for_test(&self) -> usize {
        self.once.len()
    }
    pub(crate) fn grant(
        &mut self,
        review: Review,
        duration: &str,
    ) -> Result<GrantReceipt, &'static str> {
        self.prune();
        if self.once.len() >= MAX_ONCE {
            return Err("Immediate approval receipt capacity unavailable");
        }
        if duration == "always" && !self.always_available() {
            return Err("Always approvals are disabled");
        }
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
        self.prune();
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
    #[cfg(test)]
    pub(crate) fn reuse(
        &mut self,
        tokens: &[String],
        owner: &str,
        project: &str,
        binding: &Binding,
    ) -> Option<Value> {
        self.reuse_unless_revoked(tokens, owner, project, binding, None)
    }
    /// `revoked_before` is the server-side revocation cutoff for this
    /// owner/project: any token issued at or before it is rejected.
    pub(crate) fn reuse_unless_revoked(
        &mut self,
        tokens: &[String],
        owner: &str,
        project: &str,
        binding: &Binding,
        revoked_before: Option<i64>,
    ) -> Option<Value> {
        self.prune();
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
                || revoked_before.is_some_and(|cutoff| claims.issued_at_ms <= cutoff)
                || !matches!(claims.duration.as_str(), "2h" | "4h" | "8h" | "always")
                || (claims.duration == "always" && !self.always_available())
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
            Some("/workspace"),
            key,
            true,
        )
        .unwrap();
        let mut review = review;
        review.transport = Some("plugin-transport".into());
        (grants, review)
    }
    #[test]
    fn review_is_one_time_and_expiring() {
        let (mut grants, review) = fixture(true);
        let id = grants.issue(review.clone()).unwrap();
        assert!(grants.consume_review(&id).is_some());
        assert!(grants.consume_review(&id).is_none());
        let mut expired = review;
        expired.expires_at_ms = now_ms() - 1;
        let id = grants.issue(expired).unwrap();
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
            Some("/workspace"),
            true,
            true,
        )
        .unwrap();
        assert_eq!(review.allowed_durations, vec!["once"]);
        assert_eq!(review.default_duration, "once");
        assert!(grants.grant(review.clone(), "4h").is_err());
        assert!(grants.grant(review, "once").is_ok());
    }
    #[test]
    fn forged_always_claims_and_other_invocations_are_rejected() {
        let (mut grants, review) = fixture(true);
        let token = grants.grant(review.clone(), "always").unwrap().payload
            ["classifier_approval"]["token"].as_str().unwrap().to_owned();
        let body = URL_SAFE_NO_PAD.decode(token.split('.').nth(1).unwrap()).unwrap();
        let wrong_key = GrantKey::parse(&[b'w'; 32]).unwrap();
        let wrong_signature = format!("v1.{}.{}",URL_SAFE_NO_PAD.encode(&body),
            URL_SAFE_NO_PAD.encode(wrong_key.sign(&body)));
        assert!(grants.reuse(&[wrong_signature],"owner","project",&review.binding).is_none());

        let timed = grants.grant(review.clone(), "2h").unwrap().payload
            ["classifier_approval"]["token"].as_str().unwrap().to_owned();
        let mut claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(
            timed.split('.').nth(1).unwrap()).unwrap()).unwrap();
        claims.duration = "always".into();
        claims.expires_at_ms = None;
        let edited = format!("v1.{}.{}",URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()),
            timed.split('.').nth(2).unwrap());
        assert!(grants.reuse(&[edited],"owner","project",&review.binding).is_none());

        let mut other_command = review.binding.clone();
        other_command.invocation_sha256 = "d".repeat(64);
        assert!(grants.reuse(&[token.clone()],"owner","project",&other_command).is_none());
        let mut other_cwd = review.binding.clone();
        other_cwd.invocation_sha256 = "e".repeat(64);
        assert!(grants.reuse(&[token],"owner","project",&other_cwd).is_none());
    }
    #[test]
    fn always_switch_rejects_mint_and_existing_token_reuse() {
        let (mut grants, review) = fixture(true);
        let token = grants.grant(review.clone(),"always").unwrap().payload
            ["classifier_approval"]["token"].as_str().unwrap().to_owned();
        grants.always_enabled = false;
        assert!(grants.grant(review.clone(),"always").is_err());
        assert!(grants.reuse(&[token],"owner","project",&review.binding).is_none());
        assert!(grants.grant(review,"2h").is_ok());
    }
    #[test]
    fn review_and_immediate_receipt_capacity_never_evict_live_ids() {
        let (mut grants, mut review) = fixture(true);
        let mut ids = Vec::new();
        for _ in 0..MAX_REVIEWS {
            review.id = new_id();
            ids.push(grants.issue(review.clone()).unwrap());
        }
        review.id = new_id();
        assert!(grants.issue(review.clone()).is_none());
        assert!(grants.consume_review(&ids[0]).is_some());
        assert!(grants.issue(review.clone()).is_some());
        assert!(grants.consume_review(&ids[1]).is_some());
        let expired = grants.reviews.get_mut(&ids[2]).unwrap();
        expired.expires_at_ms = now_ms() - 1;
        review.id = new_id();
        assert!(grants.issue(review.clone()).is_some());
        assert!(grants.consume_review(&ids[2]).is_none());

        let mut receipts = Vec::new();
        for _ in 0..MAX_ONCE {
            receipts.push(grants.grant(review.clone(),"once").unwrap().payload
                ["classifier_approval"]["one_use_receipt"].as_str().unwrap().to_owned());
        }
        assert!(grants.grant(review.clone(),"once").is_err());
        assert!(grants.use_once(&receipts[0],"owner","project","run","session",1,&review.binding).is_some());
        assert!(grants.grant(review.clone(),"once").is_ok());
        grants.once.get_mut(&receipts[1]).unwrap().expires_at_ms = now_ms() - 1;
        assert!(grants.grant(review,"once").is_ok());
        assert!(grants.use_once(&receipts[1],"owner","project","run","session",1,
            &fixture(true).1.binding).is_none());
    }
    #[test]
    fn review_default_never_always_even_with_forged_context() {
        let (_, mut review) = fixture(true);
        review.default_duration = "always".into();
        let mut context = json!({"grant_policy_v2_sha256":"a".repeat(64),
            "invocation_sha256":"b".repeat(64),"dependency_sha256":"c".repeat(64),
            "allowed_durations":["once","2h","always"],"approve_for":"always","reusable":true});
        for preferred in [Some("always"), None] {
            if let Some(preferred)=preferred { context["approve_for"]=json!(preferred); }
            else { context.as_object_mut().unwrap().remove("approve_for"); }
            let offered=Review::new("owner".into(),"project".into(),"run".into(),"session".into(),
                "state".into(),1,"generation".into(),0,&context,"Bash",
                &json!({"command":"x","workdir":"/workspace"}),Some("/workspace"),true,true).unwrap();
            assert_eq!(offered.default_duration,"once");
        }
    }

    #[test]
    fn reviews_without_a_verified_transport_are_never_issued() {
        let (mut grants, mut review) = fixture(true);
        review.transport = None;
        assert!(grants.issue(review.clone()).is_none());
        review.transport = Some(String::new());
        assert!(grants.issue(review).is_none());
    }
    #[test]
    fn server_side_revocation_rejects_tokens_issued_before_the_cutoff() {
        for duration in ["2h", "always"] {
            let (mut grants, review) = fixture(true);
            let token = grants.grant(review.clone(), duration).unwrap().payload["classifier_approval"]
                ["token"].as_str().unwrap().to_owned();
            let cutoff = now_ms();
            assert!(grants
                .reuse_unless_revoked(&[token.clone()], "owner", "project", &review.binding, Some(cutoff - 60_000))
                .is_some(), "older cutoff keeps a newer token");
            assert!(grants
                .reuse_unless_revoked(&[token.clone()], "owner", "project", &review.binding, Some(cutoff))
                .is_none(), "{duration} token survives revoke");
            std::thread::sleep(std::time::Duration::from_millis(2));
            let fresh = grants.grant(review.clone(), duration).unwrap().payload["classifier_approval"]
                ["token"].as_str().unwrap().to_owned();
            assert!(grants
                .reuse_unless_revoked(&[fresh], "owner", "project", &review.binding, Some(cutoff))
                .is_some(), "a grant made after revoke works");
        }
    }
    #[test]
    fn revocation_registry_is_monotonic_and_scoped() {
        let owner = format!("owner-{}", new_id());
        assert!(record_revocation(&owner, "p1", 200));
        assert!(record_revocation(&owner, "p1", 100));
        assert_eq!(local_revoked_before(&owner, "p1"), Some(200));
        assert_eq!(local_revoked_before(&owner, "p2"), None);
        assert_eq!(local_revoked_before("other", "p1"), None);
    }
}
