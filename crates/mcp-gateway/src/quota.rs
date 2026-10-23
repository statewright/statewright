//! Dormant transition accounting. No normal gateway path invokes this module.
//! Authority is read from storage; callers cannot supply a limit or cutover.
use crate::session::GatewaySession;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_LIMIT: u64 = 1_000_000_000;
// Counters also cover unlimited/legacy-grace usage and the 20% allowance.
const MAX_COUNTER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationBinding {
    pub owner: String,
    pub run_id: String,
    pub session_id: String,
    pub project_id: String,
    pub operation_id: String,
    pub expected_transition_count: u64,
    pub request_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DurableAdmissionRequest {
    pub binding: OperationBinding,
    pub event: String,
    pub event_data: Value,
    pub candidate_checkpoint: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaHold {
    schema: String,
    request: DurableAdmissionRequest,
    source_checkpoint: Value,
    period_id: String,
    used: u64,
    ceiling: u64,
    held_at: String,
}

enum AdmissionInput<'a> {
    Attempt(&'a DurableAdmissionRequest, bool),
    Continue(&'a OperationBinding),
    Cancel(&'a OperationBinding),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DurableAdmission {
    Applied {
        period_id: String,
        used_after: u64,
        enforced: bool,
    },
    Duplicate {
        period_id: String,
        used_after: u64,
        enforced: bool,
    },
    AccountingInactive,
    QuotaExceeded {
        used: u64,
        ceiling: u64,
    },
    QuotaHeld {
        operation_id: String,
        period_id: String,
        used: u64,
        ceiling: u64,
    },
    ResumeRequired {
        operation_id: String,
    },
    Cancelled,
    AlreadyApplied,
    EntitlementUnavailable,
    PeriodReconciliationRequired,
    BindingConflict,
    StaleOrForeignRun,
    InvalidCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entitlement {
    included: Option<u64>,
    period_id: String,
    anchor: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn integer(v: &Value, max: u64) -> Option<u64> {
    let n = v.as_f64()?;
    (n.is_finite() && n >= 0.0 && n <= max as f64 && n.fract() == 0.0).then_some(n as u64)
}
fn date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&s.replacen(' ', "T", 1))
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
fn ceiling(included: u64) -> Option<u64> {
    included.checked_add(included / 5)
}

// Mirrors quotaEntitlement.js; storage lookup also rejects ambiguous rows.
// Price changes deliberately do not change the period key.
fn entitlement(plan: &Value, sub: Option<&Value>, now: DateTime<Utc>) -> Option<Entitlement> {
    let limit = integer(&plan["steps_included"], MAX_LIMIT)?;
    if plan["workflow_limit"].as_f64() != Some(-1.0) {
        integer(&plan["workflow_limit"], MAX_LIMIT)?;
    }
    let unlimited = plan["transitions_unlimited"].as_bool()?;
    if unlimited && limit != 0 {
        return None;
    }
    let included = if unlimited { None } else { Some(limit) };
    if let Some(s) = sub {
        let start = date(string(s, "current_period_start"))?;
        let end = date(string(s, "quota_period_end"))?;
        if string(s, "stripe_subscription_id").is_empty()
            || string(s, "quota_period_event_id").is_empty()
            || integer(&s["quota_period_event_created"], 8_640_000_000_000)? == 0
            || string(s, "status") != "active"
            || string(s, "stripe_price_id").is_empty()
            || string(s, "stripe_price_id") != string(s, "quota_period_price_id")
            || date(string(s, "current_period_end"))? != end
            || start >= end
            || now < start
            || now >= end
        {
            return None;
        }
        Some(Entitlement {
            included,
            period_id: format!(
                "subscription:{}:{}:{}",
                string(s, "id"),
                start.timestamp_millis(),
                end.timestamp_millis()
            ),
            anchor: format!(
                "subscription:{}:{}",
                string(s, "id"),
                string(s, "stripe_subscription_id")
            ),
            start,
            end,
        })
    } else {
        let start = Utc
            .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
            .single()?;
        let (year, month) = if now.month() == 12 {
            (now.year() + 1, 1)
        } else {
            (now.year(), now.month() + 1)
        };
        let end = Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).single()?;
        Some(Entitlement {
            included,
            period_id: format!("utc:{}", start.format("%Y-%m")),
            anchor: "utc_month".into(),
            start,
            end,
        })
    }
}

fn valid_request(r: &DurableAdmissionRequest) -> bool {
    let b = &r.binding;
    [&b.owner, &b.run_id, &b.session_id, &b.operation_id]
        .iter()
        .all(|s| !s.is_empty() && s.len() <= 255)
        && b.project_id.len() <= 255
        && b.request_digest.len() == 64
        && b.request_digest.bytes().all(|b| b.is_ascii_hexdigit())
        && b.expected_transition_count < MAX_LIMIT
        && !r.event.is_empty()
        && r.event.len() <= 255
        && r.event_data.is_object()
        && r.event_data.get("_interrupt_return").is_none()
        && r.event_data.get("_fork").is_none()
        && serde_json::to_vec(&r.candidate_checkpoint)
            .map(|v| v.len() <= 524_288)
            .unwrap_or(false)
        && serde_json::to_vec(r)
            .map(|v| v.len() <= 2_097_152)
            .unwrap_or(false)
}

fn candidate(r: &DurableAdmissionRequest, previous: &Value) -> Option<GatewaySession> {
    let b = &r.binding;
    let old_state = string(&previous["session"], "current_state");
    let new_state = string(&r.candidate_checkpoint["session"], "current_state");
    let old = GatewaySession::from_checkpoint(previous.clone(), &b.session_id, old_state).ok()?;
    let new =
        GatewaySession::from_checkpoint(r.candidate_checkpoint.clone(), &b.session_id, new_state)
            .ok()?;
    if old.transition_count != b.expected_transition_count
        || new.transition_count != old.transition_count.checked_add(1)?
        || new.previous_state.as_deref() != Some(old_state)
        || serde_json::to_value(&old.definition).ok()?
            != serde_json::to_value(&new.definition).ok()?
        || old.pending_approval.is_some()
        || new.pending_approval.is_some()
        || serde_json::to_value(&old.subflow).ok()? != serde_json::to_value(&new.subflow).ok()?
        || statewright_engine::validate_definition(&new.definition).is_err()
    {
        return None;
    }
    // Dormant first slice supports exact ordinary events only. Do not turn a
    // caller-provided checkpoint into authority for a nonexistent/approval event.
    old.definition.states.get(old_state)?.on.get(&r.event)?;
    let resolved = statewright_engine::resolve_transition(
        old_state,
        &r.event,
        &r.event_data,
        &old.context,
        &old.definition,
    )
    .ok()?;
    if !resolved.transitioned
        || resolved.requires_approval
        || resolved.invoke.is_some()
        || resolved.fork.is_some()
        || resolved.new_state != new.current_state
        || resolved.new_context != new.context
    {
        return None;
    }
    // Match the ordinary SessionManager update exactly. A candidate cannot
    // silently rewrite a plan, pending approval, execution counter or context.
    let mut expected = old;
    expected.previous_state = Some(expected.current_state.clone());
    expected.current_state = resolved.new_state;
    expected.context = resolved.new_context;
    expected.transition_count += 1;
    expected.iteration_count = 0;
    expected.files_edited.clear();
    expected.context_bytes = 0;
    expected.files_read.clear();
    if serde_json::to_value(expected).ok()? != serde_json::to_value(&new).ok()? {
        return None;
    }
    // Independent controller authority must still be checked by the caller.
    Some(new)
}

/// Owner row serializes clients/runs/periods; plan/subscription locks fence
/// updates. Old monthly totals are never anniversary-period consumption.
pub async fn persist_durable_admission(
    pool: &sqlx::PgPool,
    r: &DurableAdmissionRequest,
) -> Result<DurableAdmission, sqlx::Error> {
    admit(pool, AdmissionInput::Attempt(r, false)).await
}

/// Prepare the same-run durable hold before presenting a quota pause. This
/// remains dormant until all progression paths use atomic admission.
pub async fn admit_or_hold(
    pool: &sqlx::PgPool,
    r: &DurableAdmissionRequest,
) -> Result<DurableAdmission, sqlx::Error> {
    admit(pool, AdmissionInput::Attempt(r, true)).await
}

/// Explicit Continue: only the stored operation can be resumed. Entitlement,
/// checkpoint, engine guards and binding are checked again under the row lock.
pub async fn continue_held_admission(
    pool: &sqlx::PgPool,
    binding: &OperationBinding,
) -> Result<DurableAdmission, sqlx::Error> {
    admit(pool, AdmissionInput::Continue(binding)).await
}

/// Safe cancellation charges nothing and preserves the held checkpoint as
/// evidence; it does not erase a receipt for an already committed operation.
pub async fn cancel_held_admission(
    pool: &sqlx::PgPool,
    binding: &OperationBinding,
) -> Result<DurableAdmission, sqlx::Error> {
    admit(pool, AdmissionInput::Cancel(binding)).await
}

async fn admit(
    pool: &sqlx::PgPool,
    input: AdmissionInput<'_>,
) -> Result<DurableAdmission, sqlx::Error> {
    use DurableAdmission::*;
    let b = match input {
        AdmissionInput::Attempt(r, _) => {
            if !valid_request(r) {
                return Ok(BindingConflict);
            }
            &r.binding
        }
        AdmissionInput::Continue(b) | AdmissionInput::Cancel(b) => b,
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        .execute(&mut *tx)
        .await?;
    let user: Option<Value> =
        sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE id=$1 FOR UPDATE")
            .bind(&b.owner)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(user) = user else {
        return Ok(StaleOrForeignRun);
    };
    let run: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(r) FROM workflow_runs r WHERE id=$1 AND owner=$2 AND session_id=$3 AND COALESCE(project_id,'')=$4 FOR UPDATE")
        .bind(&b.run_id).bind(&b.owner).bind(&b.session_id).bind(&b.project_id).fetch_optional(&mut *tx).await?;
    let Some(run) = run else {
        return Ok(StaleOrForeignRun);
    };
    let receipt: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM transition_quota_receipts r WHERE owner=$1 AND operation_id=$2",
    )
    .bind(&b.owner)
    .bind(&b.operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    // Replay BEFORE revision/period checks: works after later transitions,
    // completion, upgrades or a reset, without overwriting the newer checkpoint.
    if let Some(receipt) = receipt {
        if receipt["request"]["binding"] != serde_json::to_value(b).expect("binding") {
            return Ok(BindingConflict);
        }
        if let AdmissionInput::Attempt(r, _) = input {
            if receipt["request"] != serde_json::to_value(r).expect("request") {
                return Ok(BindingConflict);
            }
        }
        if matches!(input, AdmissionInput::Cancel(_)) {
            return Ok(AlreadyApplied);
        }
        let used_after = integer(&receipt["used_after"], MAX_COUNTER)
            .ok_or(sqlx::Error::Protocol("Invalid quota receipt".into()))?;
        return Ok(Duplicate {
            period_id: string(&receipt, "period_id").into(),
            used_after,
            enforced: receipt["enforced"] == true,
        });
    }
    if integer(&run["transition_count"], MAX_LIMIT) != Some(b.expected_transition_count) {
        return Ok(StaleOrForeignRun);
    }
    let mut checkpoint = run["context_snapshot"].clone();
    let held = if let Some(value) = checkpoint.get("quota_hold") {
        let Ok(hold) = serde_json::from_value::<QuotaHold>(value.clone()) else {
            return Ok(InvalidCheckpoint);
        };
        if hold.schema != "statewright/quota-hold/v1"
            || !valid_request(&hold.request)
            || date(&hold.held_at).is_none()
            || hold.period_id.is_empty()
            || hold.used < hold.ceiling
            || hold.used > MAX_COUNTER
            || hold.request.binding.owner != b.owner
            || hold.request.binding.run_id != b.run_id
            || hold.request.binding.session_id != b.session_id
            || hold.request.binding.project_id != b.project_id
            || hold.request.binding.expected_transition_count != b.expected_transition_count
        {
            return Ok(InvalidCheckpoint);
        }
        Some(hold)
    } else {
        None
    };
    let r = match input {
        AdmissionInput::Attempt(r, _) => {
            if let Some(held) = &held {
                if string(&run, "status") != "paused" {
                    return Ok(StaleOrForeignRun);
                }
                if held.request.binding.operation_id == b.operation_id && held.request != *r {
                    return Ok(BindingConflict);
                }
                return Ok(ResumeRequired {
                    operation_id: held.request.binding.operation_id.clone(),
                });
            }
            if string(&run, "status") != "running" {
                return Ok(StaleOrForeignRun);
            }
            r
        }
        AdmissionInput::Continue(_) | AdmissionInput::Cancel(_) => {
            let Some(held) = &held else {
                return Ok(StaleOrForeignRun);
            };
            if held.request.binding != *b {
                return Ok(BindingConflict);
            }
            if matches!(input, AdmissionInput::Cancel(_)) {
                if string(&run, "status") == "stopped" {
                    return Ok(Cancelled);
                }
                if string(&run, "status") != "paused" {
                    return Ok(StaleOrForeignRun);
                }
                let saved = sqlx::query("UPDATE workflow_runs SET status='stopped',completed_at=clock_timestamp()::text,updated=clock_timestamp()::text WHERE id=$1 AND owner=$2 AND session_id=$3 AND COALESCE(project_id,'')=$4 AND status='paused' AND transition_count=$5")
                    .bind(&b.run_id).bind(&b.owner).bind(&b.session_id).bind(&b.project_id).bind(b.expected_transition_count as f64).execute(&mut *tx).await?;
                if saved.rows_affected() != 1 {
                    return Err(sqlx::Error::Protocol("Quota cancellation not saved".into()));
                }
                tx.commit().await?;
                return Ok(Cancelled);
            }
            if string(&run, "status") != "paused" {
                return Ok(StaleOrForeignRun);
            }
            checkpoint
                .as_object_mut()
                .ok_or(sqlx::Error::Protocol("Invalid held checkpoint".into()))?
                .remove("quota_hold");
            // Revision alone cannot detect a same-revision context/approval
            // edit. Compare the entire durable source, including keys the
            // event would overwrite, before resolving or consuming allowance.
            if checkpoint != held.source_checkpoint {
                return Ok(InvalidCheckpoint);
            }
            &held.request
        }
    };
    let request_value = serde_json::to_value(r).expect("serializable request");
    let Some(next) = candidate(r, &checkpoint) else {
        return Ok(InvalidCheckpoint);
    };
    let rollout: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(q) FROM transition_quota_rollout q WHERE id='quota_rollout01' FOR SHARE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(rollout) = rollout else {
        return Ok(AccountingInactive);
    };
    if rollout["active"] != true {
        return Ok(AccountingInactive);
    }
    let Some(activated) = date(string(&rollout, "accounting_started_at")) else {
        return Ok(EntitlementUnavailable);
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if activated > now {
        return Ok(EntitlementUnavailable);
    }
    let subs: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(s) FROM subscriptions s WHERE \"user\"=$1 AND status='active' ORDER BY id FOR SHARE")
        .bind(&b.owner).fetch_all(&mut *tx).await?;
    if subs.len() > 1 {
        return Ok(EntitlementUnavailable);
    }
    let plans: Vec<Value> = if let Some(s) = subs.first() {
        if string(s, "stripe_price_id").trim().is_empty() {
            return Ok(EntitlementUnavailable);
        }
        sqlx::query_scalar(
            "SELECT to_jsonb(p) FROM plans p WHERE stripe_price_id=$1 ORDER BY id FOR SHARE",
        )
        .bind(string(s, "stripe_price_id"))
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_scalar("SELECT to_jsonb(p) FROM plans p WHERE name='Free' AND active=true ORDER BY id FOR SHARE").fetch_all(&mut *tx).await?
    };
    if plans.len() != 1 {
        return Ok(EntitlementUnavailable);
    }
    let Some(e) = entitlement(&plans[0], subs.first(), now) else {
        return Ok(EntitlementUnavailable);
    };
    let Some(created) = date(string(&user, "created")) else {
        return Ok(EntitlementUnavailable);
    };
    let previous: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(p) FROM transition_quota_periods p WHERE owner=$1 ORDER BY period_start DESC LIMIT 1 FOR UPDATE")
        .bind(&b.owner).fetch_optional(&mut *tx).await?;
    let mut used = 0;
    if let Some(previous) = &previous {
        if string(previous, "period_id") == e.period_id {
            if string(previous, "billing_anchor") != e.anchor
                || date(string(previous, "period_start")) != Some(e.start)
                || date(string(previous, "period_end")) != Some(e.end)
            {
                return Ok(PeriodReconciliationRequired);
            }
            used = integer(&previous["used"], MAX_COUNTER)
                .ok_or(sqlx::Error::Protocol("Invalid quota counter".into()))?;
        } else if string(previous, "billing_anchor") != e.anchor
            || date(string(previous, "period_end"))
                .map(|end| e.start < end)
                .unwrap_or(true)
        {
            return Ok(PeriodReconciliationRequired);
        }
    }
    let enforced = created >= activated || e.start >= activated;
    if enforced {
        if let Some(included) = e.included {
            let cap = ceiling(included).expect("bounded entitlement");
            if used >= cap {
                if matches!(
                    input,
                    AdmissionInput::Attempt(_, true) | AdmissionInput::Continue(_)
                ) {
                    let hold = QuotaHold {
                        schema: "statewright/quota-hold/v1".into(),
                        request: r.clone(),
                        source_checkpoint: checkpoint.clone(),
                        period_id: e.period_id.clone(),
                        used,
                        ceiling: cap,
                        held_at: now.to_rfc3339(),
                    };
                    checkpoint["quota_hold"] = serde_json::to_value(hold).expect("hold");
                    // Existing PocketBase context_snapshot field limit. Never
                    // bypass its size contract just because this is direct SQL.
                    if serde_json::to_vec(&checkpoint)
                        .map(|v| v.len() > 524_288)
                        .unwrap_or(true)
                    {
                        return Ok(InvalidCheckpoint);
                    }
                    let saved = sqlx::query("UPDATE workflow_runs SET status='paused',context_snapshot=$1,final_state=$2,updated=$3 WHERE id=$4 AND owner=$5 AND session_id=$6 AND COALESCE(project_id,'')=$7 AND transition_count=$8 AND status=$9")
                        .bind(&checkpoint).bind(string(&checkpoint["session"],"current_state")).bind(now.to_rfc3339())
                        .bind(&b.run_id).bind(&b.owner).bind(&b.session_id).bind(&b.project_id).bind(b.expected_transition_count as f64).bind(string(&run,"status")).execute(&mut *tx).await?;
                    if saved.rows_affected() != 1 {
                        return Err(sqlx::Error::Protocol("Quota hold not saved".into()));
                    }
                    tx.commit().await?;
                    return Ok(QuotaHeld {
                        operation_id: b.operation_id.clone(),
                        period_id: e.period_id,
                        used,
                        ceiling: cap,
                    });
                }
                return Ok(QuotaExceeded { used, ceiling: cap });
            }
        }
    }
    let Some(used_after) = used.checked_add(1).filter(|n| *n <= MAX_COUNTER) else {
        return Ok(EntitlementUnavailable);
    };
    let timestamp = now.to_rfc3339();
    let id = || uuid::Uuid::new_v4().simple().to_string()[..15].to_owned();
    let period_write = sqlx::query("INSERT INTO transition_quota_periods (id,owner,period_id,billing_anchor,period_start,period_end,used,created,updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (owner,period_id) DO UPDATE SET used=EXCLUDED.used,updated=EXCLUDED.updated")
        .bind(id()).bind(&b.owner).bind(&e.period_id).bind(&e.anchor).bind(e.start.to_rfc3339()).bind(e.end.to_rfc3339()).bind(used_after as f64).bind(&timestamp).execute(&mut *tx).await?;
    if period_write.rows_affected() != 1 {
        return Err(sqlx::Error::Protocol("Quota period not saved".into()));
    }
    let saved = sqlx::query("UPDATE workflow_runs SET context_snapshot=$1,transition_count=$2,final_state=$3,status=$4,updated=$5,completed_at=CASE WHEN $4='completed' THEN $5 ELSE completed_at END,transitions=(COALESCE(transitions::jsonb,'[]'::jsonb) || $6::jsonb)::json WHERE id=$7 AND owner=$8 AND session_id=$9 AND COALESCE(project_id,'')=$10 AND transition_count=$11 AND status=$12")
        .bind(&r.candidate_checkpoint).bind((b.expected_transition_count+1) as f64).bind(&next.current_state)
        .bind(if next.is_final() { "completed" } else { "running" }).bind(&timestamp)
        .bind(json!([{ "from": next.previous_state, "to": next.current_state, "event": r.event, "timestamp": timestamp }]))
        .bind(&b.run_id).bind(&b.owner).bind(&b.session_id).bind(&b.project_id).bind(b.expected_transition_count as f64).bind(string(&run,"status")).execute(&mut *tx).await?;
    if saved.rows_affected() != 1 {
        return Err(sqlx::Error::Protocol("Quota checkpoint not saved".into()));
    }
    let receipt_write = sqlx::query("INSERT INTO transition_quota_receipts (id,owner,run,session_id,project_id,operation_id,expected_transition_count,request_digest,request,period_id,used_after,enforced,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
        .bind(id()).bind(&b.owner).bind(&b.run_id).bind(&b.session_id).bind(&b.project_id).bind(&b.operation_id)
        .bind(b.expected_transition_count as f64).bind(&b.request_digest).bind(request_value).bind(&e.period_id).bind(used_after as f64).bind(enforced).bind(&timestamp).execute(&mut *tx).await?;
    if receipt_write.rows_affected() != 1 {
        return Err(sqlx::Error::Protocol("Quota receipt not saved".into()));
    }
    tx.commit().await?;
    Ok(Applied {
        period_id: e.period_id,
        used_after,
        enforced,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod hold_tests;
