use super::*;

fn now() -> DateTime<Utc> {
    date("2026-10-22T12:00:00Z").unwrap()
}
fn plan() -> Value {
    json!({"steps_included":200,"workflow_limit":3,"transitions_unlimited":false})
}
fn subscription() -> Value {
    json!({"id":"subrow","stripe_subscription_id":"sub_1","status":"active","stripe_price_id":"price_1",
        "quota_period_price_id":"price_1","quota_period_event_id":"evt_1","quota_period_event_created":1790000000,
        "current_period_start":"2026-10-10 00:00:00Z","quota_period_end":"2026-11-10 00:00:00Z","current_period_end":"2026-11-10 00:00:00Z"})
}
pub(super) fn request() -> (Value, DurableAdmissionRequest) {
    let definition =
        serde_json::from_value(json!({"id":"quota-fixture","initial":"ready","states":{
        "ready":{"on":{"NEXT":"ready","DONE":"done"}},"done":{"type":"final"}}}))
        .unwrap();
    let mut session = GatewaySession::new("quota-session".into(), definition);
    let old = session.checkpoint();
    session.previous_state = Some("ready".into());
    session.transition_count = 1;
    let r = DurableAdmissionRequest {
        binding: OperationBinding {
            owner: "owner".into(),
            run_id: "run".into(),
            session_id: session.instance_id.clone(),
            project_id: "project".into(),
            operation_id: "op1".into(),
            expected_transition_count: 0,
            request_digest: "a".repeat(64),
        },
        event: "NEXT".into(),
        event_data: json!({}),
        candidate_checkpoint: session.checkpoint(),
    };
    (old, r)
}

pub(super) async fn successor(
    pool: &sqlx::PgPool,
    r: &DurableAdmissionRequest,
    operation: &str,
) -> DurableAdmissionRequest {
    let checkpoint: Value =
        sqlx::query_scalar("SELECT context_snapshot FROM workflow_runs WHERE id=$1")
            .bind(&r.binding.run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let revision = checkpoint["session"]["transition_count"].as_u64().unwrap();
    let mut next = r.clone();
    next.binding.operation_id = operation.into();
    next.binding.expected_transition_count = revision;
    next.candidate_checkpoint = checkpoint;
    next.candidate_checkpoint["session"]["transition_count"] = json!(revision + 1);
    next.candidate_checkpoint["session"]["previous_state"] =
        next.candidate_checkpoint["session"]["current_state"].clone();
    next
}

#[test]
fn entitlement_matches_free_zero_unlimited_and_invalid_contract() {
    assert_eq!(ceiling(200), Some(240));
    assert_eq!(ceiling(4), Some(4));
    assert_eq!(ceiling(u64::MAX), None);
    let mut p = plan();
    let e = entitlement(&p, None, now()).unwrap();
    assert_eq!(e.period_id, "utc:2026-10");
    assert_eq!(e.included, Some(200));
    p["steps_included"] = json!(0);
    assert_eq!(entitlement(&p, None, now()).unwrap().included, Some(0));
    p["transitions_unlimited"] = json!(true);
    assert_eq!(entitlement(&p, None, now()).unwrap().included, None);
    p["steps_included"] = json!(200);
    assert!(entitlement(&p, None, now()).is_none());
    for v in [
        json!(-1),
        json!(0.5),
        json!("200"),
        Value::Null,
        json!(1000000001),
    ] {
        p = plan();
        p["steps_included"] = v;
        assert!(entitlement(&p, None, now()).is_none());
    }
    assert_eq!(
        entitlement(&plan(), None, date("2024-02-29T12:00:00Z").unwrap())
            .unwrap()
            .end,
        date("2024-03-01T00:00:00Z").unwrap()
    );
}

#[test]
fn paid_period_needs_verified_bounds_and_upgrade_does_not_reset() {
    let mut s = subscription();
    let e = entitlement(&plan(), Some(&s), now()).unwrap();
    let mut p = plan();
    p["steps_included"] = json!(10000);
    s["stripe_price_id"] = json!("upgraded");
    s["quota_period_price_id"] = json!("upgraded");
    assert_eq!(
        entitlement(&p, Some(&s), now()).unwrap().period_id,
        e.period_id
    );
    assert!(entitlement(&p, Some(&s), e.end).is_none());
    for key in [
        "stripe_subscription_id",
        "quota_period_event_id",
        "current_period_start",
        "quota_period_end",
        "quota_period_price_id",
    ] {
        let mut invalid = subscription();
        invalid[key] = json!("");
        assert!(entitlement(&p, Some(&invalid), now()).is_none(), "{key}");
    }
    s = subscription();
    s["current_period_end"] = json!("2026-12-01T00:00:00Z");
    assert!(entitlement(&p, Some(&s), now()).is_none());
}

#[test]
fn checkpoint_must_bind_session_revision_definition_and_approval() {
    let (old, r) = request();
    assert!(valid_request(&r));
    assert!(candidate(&r, &old).is_some());
    for (key, value) in [
        ("instance_id", json!("foreign")),
        ("transition_count", json!(3)),
        ("previous_state", json!("done")),
        ("context", Value::Null),
    ] {
        let mut bad = r.clone();
        bad.candidate_checkpoint["session"][key] = value;
        assert!(candidate(&bad, &old).is_none(), "{key}");
    }
    let mut pending = old.clone();
    pending["session"]["pending_approval"] = json!({"approval_id":"a","event":"DONE","from_state":"ready","to_state":"done","new_context":{},"message":null});
    assert!(candidate(&r, &pending).is_none());
    let mut bad = r.clone();
    bad.candidate_checkpoint["session"]["definition"]["id"] = json!("changed");
    assert!(candidate(&bad, &old).is_none());
    for event in ["nonexistent", "DONE"] {
        let mut bad = r.clone();
        bad.event = event.into();
        assert!(candidate(&bad, &old).is_none());
    }
    let mut bad = r;
    bad.candidate_checkpoint["session"]["context"] = json!({"unapproved":true});
    assert!(candidate(&bad, &old).is_none());
}

#[test]
fn ordinary_resume_cannot_discard_a_quota_hold() {
    let (old, _) = request();
    for marker in [
        Value::Null,
        json!({}),
        json!({"schema":"statewright/quota-hold/v1"}),
    ] {
        let mut held = old.clone();
        held["quota_hold"] = marker;
        assert!(
            GatewaySession::from_checkpoint(held, "quota-session", "ready")
                .unwrap_err()
                .contains("explicit Continue")
        );
    }
    assert!(GatewaySession::from_checkpoint(old, "quota-session", "ready").is_ok());
}

#[test]
fn ordinary_event_data_and_exact_session_mutation_are_verified() {
    let (old, mut r) = request();
    r.event_data = json!({"customer_result":"retained"});
    r.candidate_checkpoint["session"]["context"] = r.event_data.clone();
    assert!(candidate(&r, &old).is_some());
    for (key, value) in [
        ("plan_limit", json!(999999)),
        ("iteration_count", json!(100)),
        ("context_bytes", json!(100)),
        ("files_edited", json!(["forged"])),
    ] {
        let mut forged = r.clone();
        forged.candidate_checkpoint["session"][key] = value;
        assert!(candidate(&forged, &old).is_none(), "{key}");
    }
    for key in ["_fork", "_interrupt_return"] {
        let mut injected = r.clone();
        injected.event_data[key] = json!("forged");
        assert!(!valid_request(&injected));
    }
    let mut oversized = r.clone();
    oversized.candidate_checkpoint["session"]["context"]["oversized"] = json!("x".repeat(524_288));
    assert!(!valid_request(&oversized));
}

#[tokio::test]
#[ignore = "requires owned disposable PocketBase schema via Auldwyrm runtime harness"]
async fn durable_ledger_against_actual_migration() {
    use DurableAdmission::*;
    assert_eq!(
        std::env::var("STATEWRIGHT_QUOTA_FIXTURE").unwrap(),
        "disposable"
    );
    let url = std::env::var("STATEWRIGHT_TEST_DATABASE_URL").unwrap();
    assert!(url.contains("@127.0.0.1:"), "only owned loopback fixture");
    let owner = std::env::var("STATEWRIGHT_TEST_QUOTA_OWNER").unwrap();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let (old, mut r) = request();
    r.binding.owner = owner.clone();
    for id in ["quota_run_000001", "quota_run_000002"] {
        sqlx::query("INSERT INTO workflow_runs (id,owner,workflow_name,status,started_at,session_id,project_id,transition_count,transitions,context_snapshot,created,updated) VALUES ($1,$2,'quota-fixture','running',NOW()::text,'quota-session','project',0,'[]',$3,NOW()::text,NOW()::text)")
            .bind(id).bind(&owner).bind(&old).execute(&pool).await.unwrap();
    }
    r.binding.run_id = "quota_run_000001".into();
    assert_eq!(
        persist_durable_admission(&pool, &r).await.unwrap(),
        AccountingInactive
    );
    sqlx::query("INSERT INTO transition_quota_rollout (id,active,accounting_started_at) VALUES ('quota_rollout01',true,$1)")
        .bind((Utc::now()-chrono::Duration::days(400)).to_rfc3339()).execute(&pool).await.unwrap();
    let first = persist_durable_admission(&pool, &r).await.unwrap();
    let period = match &first {
        Applied {
            period_id,
            used_after: 1,
            enforced: true,
        } => period_id.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        persist_durable_admission(&pool, &r).await.unwrap(),
        Duplicate {
            period_id: period.clone(),
            used_after: 1,
            enforced: true
        }
    );
    let mut conflict = r.clone();
    conflict.candidate_checkpoint["session"]["context"] = json!({"different":true});
    assert_eq!(
        persist_durable_admission(&pool, &conflict).await.unwrap(),
        BindingConflict
    );
    // Distinct runs compete for the same owner's final slot.
    sqlx::query("UPDATE transition_quota_periods SET used=239 WHERE owner=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let mut next = r.clone();
    next.binding.operation_id = "op2".into();
    next.binding.expected_transition_count = 1;
    next.candidate_checkpoint["session"]["transition_count"] = json!(2);
    let mut other = r.clone();
    other.binding.run_id = "quota_run_000002".into();
    other.binding.operation_id = "op3".into();
    let (a, b) = tokio::join!(
        persist_durable_admission(&pool, &next),
        persist_durable_admission(&pool, &other)
    );
    let results = [a.unwrap(), b.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|x| matches!(
                x,
                Applied {
                    used_after: 240,
                    ..
                }
            ))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|x| matches!(
                x,
                QuotaExceeded {
                    used: 240,
                    ceiling: 240
                }
            ))
            .count(),
        1
    );
    // Response-loss replay never overwrites the winner or changes consumption.
    assert!(matches!(
        persist_durable_admission(&pool, &r).await.unwrap(),
        Duplicate { used_after: 1, .. }
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM transition_quota_receipts WHERE owner=$1")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
    for field in ["owner", "session", "project", "revision"] {
        let mut bad = next.clone();
        bad.binding.operation_id = format!("bad-{field}");
        match field {
            "owner" => bad.binding.owner = "foreign".into(),
            "session" => bad.binding.session_id = "foreign".into(),
            "project" => bad.binding.project_id = "foreign".into(),
            _ => bad.binding.expected_transition_count = 999,
        };
        assert_eq!(
            persist_durable_admission(&pool, &bad).await.unwrap(),
            StaleOrForeignRun
        );
    }
    // Trigger skips checkpoint update AFTER the bucket write: whole tx rolls back.
    sqlx::query("UPDATE transition_quota_periods SET used=10 WHERE owner=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let checkpoint: Value =
        sqlx::query_scalar("SELECT context_snapshot FROM workflow_runs WHERE id=$1")
            .bind(&r.binding.run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let revision = checkpoint["session"]["transition_count"].as_u64().unwrap();
    let mut fail = r.clone();
    fail.binding.operation_id = "rollback".into();
    fail.binding.expected_transition_count = revision;
    fail.candidate_checkpoint = checkpoint.clone();
    fail.candidate_checkpoint["session"]["transition_count"] = json!(revision + 1);
    sqlx::query("CREATE FUNCTION quota_fixture_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER quota_fixture_skip BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION quota_fixture_skip()").execute(&pool).await.unwrap();
    assert!(persist_durable_admission(&pool, &fail).await.is_err());
    sqlx::query("DROP TRIGGER quota_fixture_skip ON workflow_runs")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION quota_fixture_skip()")
        .execute(&pool)
        .await
        .unwrap();
    let used: i64 =
        sqlx::query_scalar("SELECT used::bigint FROM transition_quota_periods WHERE owner=$1")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(used, 10);
    let saved: Value = sqlx::query_scalar("SELECT context_snapshot FROM workflow_runs WHERE id=$1")
        .bind(&r.binding.run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(saved, checkpoint);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transition_quota_receipts WHERE operation_id='rollback'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    // Same period string cannot mask a different billing authority.
    sqlx::query("UPDATE transition_quota_periods SET billing_anchor='foreign' WHERE owner=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        persist_durable_admission(&pool, &fail).await.unwrap(),
        PeriodReconciliationRequired
    );
    sqlx::query(
        "UPDATE transition_quota_periods SET billing_anchor='utc_month',used=240 WHERE owner=$1",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    // Existing users record exact new usage but do not hard-stop before reset.
    let activation = Utc::now() - chrono::Duration::seconds(5);
    sqlx::query("UPDATE users SET created=$1 WHERE id=$2")
        .bind((activation - chrono::Duration::days(2)).to_rfc3339())
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE transition_quota_rollout SET accounting_started_at=$1")
        .bind(activation.to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    let legacy = successor(&pool, &r, "legacy").await;
    assert!(matches!(
        persist_durable_admission(&pool, &legacy).await.unwrap(),
        Applied {
            used_after: 241,
            enforced: false,
            ..
        }
    ));
    // Re-enable fixture's prior cutover and upgrade: same bucket, no free reset.
    sqlx::query("UPDATE transition_quota_rollout SET accounting_started_at=$1")
        .bind((Utc::now() - chrono::Duration::days(400)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plans SET steps_included=500 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    let upgraded = successor(&pool, &r, "upgrade").await;
    assert!(matches!(
        persist_durable_admission(&pool, &upgraded).await.unwrap(),
        Applied {
            used_after: 242,
            enforced: true,
            ..
        }
    ));
    let zero = successor(&pool, &r, "zero").await;
    sqlx::query("UPDATE plans SET steps_included=0 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        persist_durable_admission(&pool, &zero).await.unwrap(),
        QuotaExceeded {
            used: 242,
            ceiling: 0
        }
    );
    sqlx::query("UPDATE plans SET transitions_unlimited=true WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    let unlimited = successor(&pool, &r, "unlimited").await;
    assert!(matches!(
        persist_durable_admission(&pool, &unlimited).await.unwrap(),
        Applied {
            used_after: 243,
            ..
        }
    ));
    sqlx::query(
        "UPDATE plans SET steps_included=200,transitions_unlimited=false WHERE name='Free'",
    )
    .execute(&pool)
    .await
    .unwrap();
    // Stored earlier bucket is retained across the next verified boundary.
    let current = entitlement(&plan(), None, Utc::now()).unwrap();
    let prior = entitlement(&plan(), None, current.start - chrono::Duration::seconds(1)).unwrap();
    sqlx::query("UPDATE transition_quota_periods SET period_id=$1,period_start=$2,period_end=$3 WHERE owner=$4")
        .bind(&prior.period_id).bind(prior.start.to_rfc3339()).bind(prior.end.to_rfc3339()).bind(&owner).execute(&pool).await.unwrap();
    let reset = successor(&pool, &r, "reset").await;
    assert!(matches!(
        persist_durable_admission(&pool, &reset).await.unwrap(),
        Applied {
            used_after: 1,
            enforced: true,
            ..
        }
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transition_quota_periods WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
    assert!(matches!(
        persist_durable_admission(&pool, &r).await.unwrap(),
        Duplicate { used_after: 1, .. }
    ));
    // Inactive applies to unlimited too. No granted allowance when off.
    sqlx::query("UPDATE transition_quota_rollout SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    let inactive = successor(&pool, &r, "inactive").await;
    assert_eq!(
        persist_durable_admission(&pool, &inactive).await.unwrap(),
        AccountingInactive
    );
    pool.close().await;
}
