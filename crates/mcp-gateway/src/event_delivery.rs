//! Authenticated, durable webhook delivery using the gateway's existing database.
//! No bearer tokens are persisted. A subscription retains only its grant hash;
//! deliveries recheck that grant and the owned run before contacting the receiver.

use crate::events::*;
use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use chrono::{DateTime, Duration as TimeDelta, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{sync::Arc, time::Duration};

pub struct EventService {
    pool: PgPool,
    transport: Arc<dyn CallbackTransport>,
}

pub struct EventPrincipal<'a> {
    pub owner: &'a str,
    pub bearer: &'a str,
    pub resource: &'a str,
}

impl EventService {
    pub async fn initialize(pool: PgPool) -> Result<Arc<Self>, sqlx::Error> {
        // IF NOT EXISTS alone cannot serialize concurrent catalog creation.
        // Internal and public gateways share this schema. Keep the lock and
        // DDL in one transaction, bounded and released on failure/disconnect.
        let mut transaction = pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(1937204581, 1)")
            .execute(&mut *transaction)
            .await?;
        sqlx::raw_sql(include_str!("event_delivery.sql"))
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(Arc::new(Self {
            pool,
            transport: Arc::new(HttpsCallbacks),
        }))
    }

    pub fn spawn_worker(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_secs(2));
            loop {
                ticks.tick().await;
                let Some(service) = service.upgrade() else {
                    break;
                };
                // At most 16 sends per tick, each bounded by its own deadline.
                for _ in 0..16 {
                    match service.deliver_one().await {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(_) => {
                            tracing::warn!("MCP event outbox unavailable");
                            break;
                        }
                    }
                }
                // Reclaim secrets promptly after expiry; retain delivery receipts 24h.
                let _ = sqlx::query("UPDATE statewright_events.subscriptions SET enabled=false,secret='',previous_secret=NULL WHERE expires_at<=now() AND enabled")
                    .execute(&service.pool).await;
                let _ = sqlx::query("UPDATE statewright_events.subscriptions SET previous_secret=NULL WHERE rotation_until<=now() AND previous_secret IS NOT NULL")
                    .execute(&service.pool).await;
                let _ = sqlx::query("DELETE FROM statewright_events.subscriptions WHERE expires_at < now() - interval '1 day'")
                    .execute(&service.pool).await;
                let _ = sqlx::query("DELETE FROM statewright_events.deliveries WHERE status <> 'pending' AND created_at < now() - interval '1 day'")
                    .execute(&service.pool).await;
            }
        });
    }

    pub async fn handle(
        &self,
        principal: EventPrincipal<'_>,
        request: &JsonRpcRequest,
    ) -> JsonRpcResponse {
        let result = self.dispatch(principal, request).await;
        match result {
            Ok(value) => JsonRpcResponse::success(request.id.clone(), value),
            Err((code, reason)) => {
                let mut response = JsonRpcResponse::error(
                    request.id.clone(),
                    code,
                    if code == -32015 {
                        "CallbackEndpointError"
                    } else {
                        "Event request rejected"
                    },
                );
                response.error.as_mut().unwrap().data = Some(json!({"reason":reason}));
                response
            }
        }
    }

    async fn dispatch(
        &self,
        principal: EventPrincipal<'_>,
        request: &JsonRpcRequest,
    ) -> Result<Value, (i32, &'static str)> {
        let params = request.params.as_ref().cloned().unwrap_or(json!({}));
        if !params.is_object() {
            return Err((-32602, "invalid_params"));
        }
        if request.method == "events/list" {
            if !params["cursor"].is_null() {
                return Err((-32602, "unsupported_cursor"));
            }
            return Ok(event_catalog());
        }
        if !["events/subscribe", "events/unsubscribe"].contains(&request.method.as_str()) {
            return Err((-32601, "method_not_found"));
        }
        if params["name"] != WORKFLOW_LIFECYCLE_EVENT {
            return Err((-32602, "unknown_event"));
        }
        let filter = EventFilter::parse(&params["arguments"]).map_err(|e| (-32602, e))?;
        if params["delivery"]["mode"] != "webhook" {
            return Err((-32602, "unsupported_delivery"));
        }
        let raw_url = params["delivery"]["url"]
            .as_str()
            .ok_or((-32602, "invalid_url"))?;
        let url = callback_url(raw_url).map_err(|e| (-32602, e))?.to_string();
        let id = subscription_id(principal.owner, &url, &filter);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| (-32603, "storage_unavailable"))?;
        // Same owner serializes refresh/unsubscribe, including cancellation of
        // outstanding verification. No callbacks survive an acknowledged delete.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(principal.owner)
            .execute(&mut *tx)
            .await
            .map_err(|_| (-32603, "storage_unavailable"))?;
        if request.method == "events/unsubscribe" {
            sqlx::query("DELETE FROM statewright_events.subscriptions WHERE id=$1 AND owner_id=$2")
                .bind(&id)
                .bind(principal.owner)
                .execute(&mut *tx)
                .await
                .map_err(|_| (-32603, "storage_unavailable"))?;
            tx.commit()
                .await
                .map_err(|_| (-32603, "storage_unavailable"))?;
            return Ok(json!({}));
        }
        if !params["cursor"].is_null() {
            return Err((-32602, "unsupported_cursor"));
        }
        let ttl = granted_ttl(&params).map_err(|e| (-32602, e))?;
        let secret = params["delivery"]["secret"]
            .as_str()
            .ok_or((-32602, "invalid_secret"))?;
        let key = SigningKey::parse(secret).map_err(|e| (-32602, e))?;
        let grant_hash = format!("{:x}", Sha256::digest(principal.bearer.as_bytes()));
        if !authorized(
            &mut tx,
            &grant_hash,
            principal.owner,
            principal.resource,
            &filter,
        )
        .await
        .map_err(|_| (-32603, "authority_unavailable"))?
        {
            return Err((-32024, "run_or_grant_not_authorized"));
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM statewright_events.subscriptions WHERE owner_id=$1 AND enabled AND expires_at > now() AND id <> $2")
            .bind(principal.owner).bind(&id).fetch_one(&mut *tx).await.map_err(|_|(-32603,"storage_unavailable"))?;
        if count >= 64 {
            return Err((-32000, "subscription_limit"));
        }
        let verified: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM statewright_events.subscriptions WHERE owner_id=$1 AND callback_url=$2 AND secret=$3 AND enabled AND expires_at>now() AND verified_at>now()-interval '5 minutes')")
            .bind(principal.owner).bind(&url).bind(secret).fetch_one(&mut *tx).await.map_err(|_|(-32603,"storage_unavailable"))?;
        if !verified {
            verify_callback(&*self.transport, &url, &id, &key)
                .await
                .map_err(|e| (-32015, e))?;
        }
        let now = Utc::now();
        let expires = now + TimeDelta::milliseconds(ttl);
        // Rotate signing keys for five minutes; never return either key.
        sqlx::query("INSERT INTO statewright_events.subscriptions AS s (id,owner_id,key_hash,resource,run_id,run_session_id,callback_url,secret,verified_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET key_hash=EXCLUDED.key_hash, resource=EXCLUDED.resource, previous_secret=CASE WHEN s.secret<>EXCLUDED.secret AND s.enabled AND s.expires_at>now() THEN s.secret ELSE s.previous_secret END, rotation_until=CASE WHEN s.secret<>EXCLUDED.secret AND s.enabled AND s.expires_at>now() THEN now()+interval '5 minutes' ELSE s.rotation_until END, secret=EXCLUDED.secret, verified_at=CASE WHEN $11 THEN s.verified_at ELSE EXCLUDED.verified_at END, expires_at=EXCLUDED.expires_at, enabled=true")
            .bind(&id).bind(principal.owner).bind(&grant_hash).bind(principal.resource)
            .bind(&filter.run_id).bind(&filter.run_session_id).bind(&url).bind(secret).bind(now).bind(expires).bind(verified)
            .execute(&mut *tx).await.map_err(|_|(-32603,"storage_unavailable"))?;
        tx.commit()
            .await
            .map_err(|_| (-32603, "storage_unavailable"))?;
        Ok(json!({"id":id,"refreshBefore":expires.to_rfc3339(),"cursor":null,"truncated":false}))
    }

    pub async fn publish(&self, event: &WorkflowLifecycleEvent) -> Result<(), sqlx::Error> {
        let Some(run) = &event.run_id else {
            return Ok(());
        };
        let body = serde_json::to_string(&json!({"eventId":event.event_id,
            "name":WORKFLOW_LIFECYCLE_EVENT,"timestamp":event.occurred_at,"cursor":null,
            "data":{"run_id":run,"run_session_id":event.run_session_id,"workflow":event.workflow,
                "state":event.state,"state_epoch":event.state_epoch,"kind":event.kind,"status":event.status}})).unwrap();
        sqlx::query("INSERT INTO statewright_events.deliveries(subscription_id,event_id,body) SELECT id,$1,$2 FROM statewright_events.subscriptions WHERE owner_id=$3 AND run_id=$4 AND run_session_id=$5 AND enabled AND expires_at>now() ON CONFLICT DO NOTHING")
            .bind(&event.event_id).bind(body).bind(&event.owner_id).bind(run).bind(&event.run_session_id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn deliver_one(&self) -> Result<bool, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        // Subscription row lock serializes rotation/cancellation with in-flight
        // sends. SKIP LOCKED allows multiple gateway workers without duplicates.
        let row = sqlx::query("SELECT s.*, d.event_id,d.body,d.attempts FROM statewright_events.deliveries d JOIN statewright_events.subscriptions s ON s.id=d.subscription_id WHERE d.status='pending' AND d.next_attempt_at<=now() ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF s,d SKIP LOCKED")
            .fetch_optional(&mut *tx).await?;
        let Some(row) = row else { return Ok(false) };
        let id: String = row.get("id");
        let event_id: String = row.get("event_id");
        let filter = EventFilter {
            run_id: row.get("run_id"),
            run_session_id: row.get("run_session_id"),
        };
        let allowed = row.get::<bool, _>("enabled")
            && row.get::<DateTime<Utc>, _>("expires_at") > Utc::now()
            && authorized(
                &mut tx,
                &row.get::<String, _>("key_hash"),
                &row.get::<String, _>("owner_id"),
                &row.get::<String, _>("resource"),
                &filter,
            )
            .await?;
        if !allowed {
            sqlx::query("UPDATE statewright_events.subscriptions SET enabled=false,secret='',previous_secret=NULL WHERE id=$1").bind(&id).execute(&mut *tx).await?;
            sqlx::query("UPDATE statewright_events.deliveries SET status='cancelled' WHERE subscription_id=$1 AND status='pending'").bind(&id).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(true);
        }
        let body: String = row.get("body");
        let now = Utc::now();
        let key = SigningKey::parse(&row.get::<String, _>("secret"));
        let result = if let Ok(key) = key {
            let mut signature = key.sign(&event_id, now.timestamp(), body.as_bytes());
            if row
                .get::<Option<DateTime<Utc>>, _>("rotation_until")
                .is_some_and(|t| t > now)
            {
                if let Some(previous) = row.get::<Option<String>, _>("previous_secret") {
                    if let Ok(old) = SigningKey::parse(&previous) {
                        signature.push(' ');
                        signature.push_str(&old.sign(&event_id, now.timestamp(), body.as_bytes()));
                    }
                }
            }
            tokio::time::timeout(
                Duration::from_secs(10),
                self.transport.post(
                    &row.get::<String, _>("callback_url"),
                    &id,
                    &event_id,
                    now.timestamp(),
                    &signature,
                    body.as_bytes(),
                ),
            )
            .await
            .map_err(|_| "timeout")
            .and_then(|r| r)
        } else {
            Err("invalid_stored_secret")
        };
        let attempts: i32 = row.get::<i32, _>("attempts") + 1;
        let status_code = result.as_ref().ok().map(|r| r.status);
        let accepted = status_code.is_some_and(|s| (200..300).contains(&s));
        let retry = if accepted {
            None
        } else {
            retry_delay(status_code, attempts as u32)
        };
        let status = if accepted {
            "delivered"
        } else if retry.is_some() {
            "pending"
        } else {
            "failed"
        };
        let next = now + TimeDelta::seconds(retry.map_or(0, |d| d.as_secs() as i64));
        sqlx::query("UPDATE statewright_events.deliveries SET status=$1,attempts=$2,next_attempt_at=$3 WHERE subscription_id=$4 AND event_id=$5")
            .bind(status).bind(attempts).bind(next).bind(&id).bind(&event_id).execute(&mut *tx).await?;
        if status_code == Some(410) {
            sqlx::query("UPDATE statewright_events.subscriptions SET enabled=false,secret='',previous_secret=NULL WHERE id=$1").bind(&id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(true)
    }
}

async fn authorized(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    hash: &str,
    owner: &str,
    resource: &str,
    filter: &EventFilter,
) -> Result<bool, sqlx::Error> {
    // Mirror apiKeyAuthorization.js without retaining a bearer credential.
    // A missing/malformed expiry, scope, owner or audience fails closed.
    let grant: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(k) FROM api_keys k WHERE key_hash=$1 AND owner=$2 FOR SHARE",
    )
    .bind(hash)
    .bind(owner)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(grant) = grant else { return Ok(false) };
    let expiry = grant["expires_at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    if !expiry.is_some_and(|t| t > Utc::now())
        || !grant["scope"]
            .as_str()
            .is_some_and(|s| s.split_whitespace().any(|s| s == "mcp"))
    {
        return Ok(false);
    }
    let audience = grant["oauth_resource"].as_str().unwrap_or("");
    if !audience.is_empty() && audience != resource {
        return Ok(false);
    }
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE id=$1 AND owner=$2 AND session_id=$3)",
    )
    .bind(&filter.run_id)
    .bind(owner)
    .bind(&filter.run_session_id)
    .fetch_one(&mut **tx)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct Receiver {
        calls: Mutex<Vec<(String, String, Vec<u8>)>>,
        status: std::sync::atomic::AtomicU16,
    }
    #[async_trait::async_trait]
    impl CallbackTransport for Receiver {
        async fn post(
            &self,
            _: &str,
            sub: &str,
            id: &str,
            ts: i64,
            sig: &str,
            body: &[u8],
        ) -> Result<CallbackResponse, &'static str> {
            assert!(sub.starts_with("sub_"));
            let keys = [
                SigningKey::parse(&secret(42)).unwrap(),
                SigningKey::parse(&secret(43)).unwrap(),
            ];
            assert!(
                keys.iter()
                    .any(|k| sig.split(' ').any(|s| s == k.sign(id, ts, body)))
            );
            let data: Value = serde_json::from_slice(body).unwrap();
            self.calls
                .lock()
                .await
                .push((id.into(), sig.into(), body.to_vec()));
            if data["type"] == "verification" {
                return Ok(CallbackResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"challenge":data["challenge"]})).unwrap(),
                });
            }
            Ok(CallbackResponse {
                status: self.status.load(std::sync::atomic::Ordering::SeqCst),
                body: Vec::new(),
            })
        }
    }
    fn secret(byte: u8) -> String {
        format!("whsec_{}", STANDARD.encode([byte; 32]))
    }
    fn request(method: &str) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: method.into(),
            params: Some(json!({
            "name":WORKFLOW_LIFECYCLE_EVENT,"arguments":{"run_id":"fixture-run","run_session_id":"fixture-session"},
            "delivery":{"mode":"webhook","url":"https://receiver.example/callback","secret":secret(42)},"ttlMs":60000})),
        }
    }
    fn principal() -> EventPrincipal<'static> {
        EventPrincipal {
            owner: "fixture-owner",
            bearer: "sw_live_eventsfixture",
            resource: "https://mcp.example",
        }
    }

    #[tokio::test]
    #[ignore = "requires explicitly supplied disposable events_fixture PostgreSQL database"]
    async fn postgres_outbox_lifecycle() {
        let url = std::env::var("STATEWRIGHT_EVENTS_TEST_DATABASE_URL")
            .expect("disposable test DB required");
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.path(), "/events_fixture");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .unwrap();
        // Two gateway deployments initialize the same database concurrently.
        // Prove initialization participates in the transaction-scoped lock,
        // rather than relying on IF NOT EXISTS (which races in pg_namespace).
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(1937204581, 1)")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let initializing = EventService::initialize(pool.clone());
        tokio::pin!(initializing);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut initializing)
                .await
                .is_err(),
            "schema initialization must wait for the other gateway's transaction"
        );
        let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1937204581 AND objid=1 AND NOT granted")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(
            waiting, 1,
            "pending initialization must actually wait on the database lock"
        );
        blocker.rollback().await.unwrap();
        initializing.await.unwrap();
        let (left, right) = tokio::join!(
            EventService::initialize(pool.clone()),
            EventService::initialize(pool.clone())
        );
        left.unwrap();
        right.unwrap();
        // This database name and loopback check deliberately exclude live data.
        sqlx::raw_sql("CREATE TABLE IF NOT EXISTS api_keys(key_hash text PRIMARY KEY,owner text,scope text,expires_at text,oauth_resource text); CREATE TABLE IF NOT EXISTS workflow_runs(id text PRIMARY KEY,owner text,session_id text);")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql("ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS status text; ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS final_state text; ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS context_snapshot jsonb; ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS updated text;")
            .execute(&pool).await.unwrap();
        let hash = format!("{:x}", Sha256::digest(principal().bearer.as_bytes()));
        sqlx::query("INSERT INTO api_keys VALUES ($1,'fixture-owner','mcp',$2,'https://mcp.example') ON CONFLICT(key_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at")
            .bind(&hash).bind((Utc::now()+TimeDelta::hours(1)).to_rfc3339()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO workflow_runs(id,owner,session_id) VALUES ('fixture-run','fixture-owner','fixture-session') ON CONFLICT DO NOTHING").execute(&pool).await.unwrap();
        EventService::initialize(pool.clone()).await.unwrap();
        sqlx::query("DELETE FROM statewright_events.subscriptions WHERE owner_id='fixture-owner'")
            .execute(&pool)
            .await
            .unwrap();
        let receiver = Arc::new(Receiver::default());
        receiver
            .status
            .store(503, std::sync::atomic::Ordering::SeqCst);
        let service = EventService {
            pool: pool.clone(),
            transport: receiver.clone(),
        };
        let subscribe = request("events/subscribe");
        let result = service.handle(principal(), &subscribe).await;
        assert!(result.error.is_none(), "{:?}", result.error);
        let id = result.result.as_ref().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!serde_json::to_string(&result).unwrap().contains("whsec_"));
        assert!(
            service
                .handle(principal(), &subscribe)
                .await
                .error
                .is_none()
        );
        assert_eq!(
            receiver.calls.lock().await.len(),
            1,
            "verification is cached"
        );
        let (first, second) = tokio::join!(
            service.handle(principal(), &subscribe),
            service.handle(principal(), &subscribe)
        );
        assert_eq!(
            first.result.as_ref().unwrap()["id"],
            second.result.as_ref().unwrap()["id"]
        );
        assert_eq!(
            receiver.calls.lock().await.len(),
            1,
            "concurrent refresh keeps one subscription"
        );
        // The actual database grant, not the caller's request, controls delivery.
        for (scope, audience, expiry) in [
            (
                "other",
                "https://mcp.example",
                (Utc::now() + TimeDelta::hours(1)).to_rfc3339(),
            ),
            (
                "mcp",
                "https://foreign.example",
                (Utc::now() + TimeDelta::hours(1)).to_rfc3339(),
            ),
            ("mcp", "https://mcp.example", "not-a-date".into()),
        ] {
            sqlx::query(
                "UPDATE api_keys SET scope=$1,oauth_resource=$2,expires_at=$3 WHERE key_hash=$4",
            )
            .bind(scope)
            .bind(audience)
            .bind(expiry)
            .bind(&hash)
            .execute(&pool)
            .await
            .unwrap();
            assert_eq!(
                service
                    .handle(principal(), &subscribe)
                    .await
                    .error
                    .unwrap()
                    .code,
                -32024
            );
        }
        sqlx::query("UPDATE api_keys SET scope='mcp',oauth_resource='https://mcp.example',expires_at=$1 WHERE key_hash=$2")
            .bind((Utc::now()+TimeDelta::hours(1)).to_rfc3339()).bind(&hash).execute(&pool).await.unwrap();
        let mut wrong = request("events/subscribe");
        wrong.params.as_mut().unwrap()["arguments"]["run_session_id"] = json!("foreign-session");
        assert_eq!(
            service
                .handle(principal(), &wrong)
                .await
                .error
                .unwrap()
                .code,
            -32024
        );
        let foreign = EventPrincipal {
            owner: "foreign",
            ..principal()
        };
        assert_eq!(
            service
                .handle(foreign, &subscribe)
                .await
                .error
                .unwrap()
                .code,
            -32024
        );
        let mut event = WorkflowLifecycleEvent {
            event_id: "fixture-event".into(),
            occurred_at: Utc::now().to_rfc3339(),
            owner_id: "fixture-owner".into(),
            run_id: Some("fixture-run".into()),
            run_session_id: "fixture-session".into(),
            workflow: Some("test".into()),
            state: Some("complete".into()),
            state_epoch: 3,
            kind: WorkflowLifecycleKind::Finalized,
            status: WorkflowLifecycleStatus::Final,
        };
        service.publish(&event).await.unwrap();
        service.publish(&event).await.unwrap();
        assert!(service.deliver_one().await.unwrap());
        let attempts:i32=sqlx::query_scalar("SELECT attempts FROM statewright_events.deliveries WHERE subscription_id=$1 AND event_id='fixture-event'").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(attempts, 1);
        sqlx::query("UPDATE statewright_events.deliveries SET next_attempt_at=now() WHERE subscription_id=$1").bind(&id).execute(&pool).await.unwrap();
        // New service, same database: no in-memory bearer/registry needed.
        drop(service);
        let service = EventService {
            pool: pool.clone(),
            transport: receiver.clone(),
        };
        receiver
            .status
            .store(204, std::sync::atomic::Ordering::SeqCst);
        assert!(service.deliver_one().await.unwrap());
        assert!(!service.deliver_one().await.unwrap());
        {
            let calls = receiver.calls.lock().await;
            assert_eq!(calls[1].0, calls[2].0);
            assert_eq!(calls[1].2, calls[2].2);
            let payload: Value = serde_json::from_slice(&calls[2].2).unwrap();
            assert_eq!(payload["data"]["status"], "final");
            assert!(payload["data"].get("instructions").is_none());
        }
        let mut rotate = subscribe.clone();
        rotate.params.as_mut().unwrap()["delivery"]["secret"] = json!(secret(43));
        assert!(service.handle(principal(), &rotate).await.error.is_none());
        event.event_id = "rotation-event".into();
        service.publish(&event).await.unwrap();
        service.deliver_one().await.unwrap();
        assert_eq!(
            receiver
                .calls
                .lock()
                .await
                .last()
                .unwrap()
                .1
                .split(' ')
                .count(),
            2
        );
        event.event_id = "cancel-event".into();
        service.publish(&event).await.unwrap();
        let unsubscribe = request("events/unsubscribe");
        assert!(
            service
                .handle(principal(), &unsubscribe)
                .await
                .error
                .is_none()
        );
        assert!(
            service
                .handle(principal(), &unsubscribe)
                .await
                .error
                .is_none()
        );
        assert!(!service.deliver_one().await.unwrap());
        assert!(
            service
                .handle(principal(), &subscribe)
                .await
                .error
                .is_none()
        );
        event.event_id = "revoked-event".into();
        service.publish(&event).await.unwrap();
        let before = receiver.calls.lock().await.len();
        sqlx::query("UPDATE api_keys SET expires_at=$1 WHERE key_hash=$2")
            .bind((Utc::now() - TimeDelta::seconds(1)).to_rfc3339())
            .bind(&hash)
            .execute(&pool)
            .await
            .unwrap();
        service.deliver_one().await.unwrap();
        assert_eq!(receiver.calls.lock().await.len(), before);
        let cancelled:String=sqlx::query_scalar("SELECT status FROM statewright_events.deliveries WHERE subscription_id=$1 AND event_id='revoked-event'").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(cancelled, "cancelled");
        let public_grants:i64=sqlx::query_scalar("SELECT count(*) FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE n.nspname='statewright_events' AND a.grantee=0").fetch_one(&pool).await.unwrap();
        assert_eq!(public_grants, 0);

        // Exercise the real Gateway producer, not just constructed event data.
        sqlx::query("UPDATE api_keys SET expires_at=$1 WHERE key_hash=$2")
            .bind((Utc::now() + TimeDelta::hours(1)).to_rfc3339())
            .bind(&hash)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            service
                .handle(principal(), &subscribe)
                .await
                .error
                .is_none()
        );
        let definition: statewright_engine::MachineDefinition =
            serde_json::from_value(json!({"id":"test","initial":"work","context":{},"states":{
                "work":{"on":{"DONE":"done"}},"done":{"type":"final"}
            }}))
            .unwrap();
        let manager = crate::session::SessionManager::new();
        manager.create("fixture-session".into(), definition.clone());
        let mut gateway = crate::gateway::Gateway::new(
            manager,
            crate::upstream::UpstreamManager::empty(),
            "fixture-session".into(),
            std::collections::HashMap::from([("test".into(), definition)]),
            Some("test".into()),
            "fixture-owner".into(),
            None,
        );
        gateway.seed_native_usage_run("fixture-run", "work");
        gateway.event_service = Some(Arc::new(EventService {
            pool: pool.clone(),
            transport: receiver.clone(),
        }));
        let call = |name: &str, args: Value| JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: Some(json!({"name":name,"arguments":args})),
        };
        let before: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM statewright_events.deliveries WHERE subscription_id=$1",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        gateway
            .handle_message(call("statewright_get_state", json!({})))
            .await
            .unwrap();
        gateway
            .handle_message(call(
                "statewright_transition",
                json!({"event":"NOT_AN_EVENT"}),
            ))
            .await
            .unwrap();
        let unchanged: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM statewright_events.deliveries WHERE subscription_id=$1",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, unchanged);
        gateway
            .handle_message(call("statewright_transition", json!({"event":"DONE"})))
            .await
            .unwrap();
        gateway
            .handle_message(call("statewright_deactivate", json!({})))
            .await
            .unwrap();
        let bodies:Vec<String>=sqlx::query_scalar("SELECT body FROM statewright_events.deliveries WHERE subscription_id=$1 AND status='pending' ORDER BY created_at").bind(&id).fetch_all(&pool).await.unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&bodies[0]).unwrap()["data"]["status"],
            "final"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&bodies[1]).unwrap()["data"]["status"],
            "inactive"
        );
        receiver
            .status
            .store(410, std::sync::atomic::Ordering::SeqCst);
        service.deliver_one().await.unwrap();
        let delivered = receiver.calls.lock().await.len();
        service.deliver_one().await.unwrap();
        assert_eq!(
            receiver.calls.lock().await.len(),
            delivered,
            "410 cancels remaining sends"
        );
        assert!(
            service
                .handle(principal(), &subscribe)
                .await
                .error
                .is_none()
        );
        // A real pause must save the checkpoint before emitting the event.
        let definition: statewright_engine::MachineDefinition = serde_json::from_value(json!({
            "id":"pause-test","initial":"work","context":{},"states":{"work":{"on":{"DONE":"done"}},"done":{"type":"final"}}
        })).unwrap();
        let manager = crate::session::SessionManager::new();
        manager.create("fixture-session".into(), definition.clone());
        let mut paused = crate::gateway::Gateway::new(
            manager,
            crate::upstream::UpstreamManager::empty(),
            "fixture-session".into(),
            std::collections::HashMap::from([("pause-test".into(), definition)]),
            Some("pause-test".into()),
            "fixture-owner".into(),
            Some(pool.clone()),
        );
        paused.seed_native_usage_run("fixture-run", "work");
        paused.event_service = gateway.event_service.clone();
        paused.set_remote_host_model_control(true);
        paused.set_web_workflow_guidance(true);
        let result = paused
            .handle_message(call("statewright_pause", json!({})))
            .await
            .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        let content = &result.result.as_ref().unwrap()["content"];
        let guidance: Value = serde_json::from_str(content[1]["text"].as_str().unwrap()).unwrap();
        assert_eq!(guidance["web_workflow"]["status"], "paused");
        let status: String =
            sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id='fixture-run'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "paused");
        let body: String = sqlx::query_scalar("SELECT body FROM statewright_events.deliveries WHERE subscription_id=$1 AND status='pending'").bind(&id).fetch_one(&pool).await.unwrap();
        let data: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(data["data"]["status"], "paused");
        assert_eq!(data["data"]["run_id"], "fixture-run");
        pool.close().await;
    }
}
