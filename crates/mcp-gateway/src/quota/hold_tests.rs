use super::tests::{request, successor};
use super::*;

async fn snapshot(pool: &sqlx::PgPool, id: &str) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(r) FROM workflow_runs r WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires owned disposable PocketBase schema via private runtime harness"]
async fn durable_hold_against_actual_migration() {
    use DurableAdmission::*;
    assert_eq!(
        std::env::var("STATEWRIGHT_QUOTA_FIXTURE").unwrap(),
        "disposable"
    );
    let url = std::env::var("STATEWRIGHT_TEST_DATABASE_URL").unwrap();
    assert!(url.contains("@127.0.0.1:"));
    let owner = std::env::var("STATEWRIGHT_TEST_QUOTA_HOLD_OWNER").unwrap();
    let mut pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let (mut old, mut r) = request();
    old["session"]["context"] = json!({"x":1});
    r.event_data = json!({"x":2});
    r.candidate_checkpoint["session"]["context"] = r.event_data.clone();
    r.binding.owner = owner.clone();
    r.binding.run_id = "quota_holdrun001".into();
    r.binding.operation_id = "hold-operation".into();
    for id in [
        "quota_holdrun001",
        "quota_holdrun002",
        "quota_holdrun003",
        "quota_holdrun004",
    ] {
        sqlx::query("INSERT INTO workflow_runs(id,owner,workflow_name,status,started_at,session_id,project_id,transition_count,transitions,context_snapshot,created,updated) VALUES($1,$2,'quota-fixture','running',NOW()::text,'quota-session','project',0,'[]',$3,NOW()::text,NOW()::text)")
            .bind(id).bind(&owner).bind(&old).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO transition_quota_rollout(id,active,accounting_started_at) VALUES('quota_rollout01',true,$1)")
        .bind((Utc::now()-chrono::Duration::days(400)).to_rfc3339()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE plans SET steps_included=0 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        admit_or_hold(&pool, &r).await.unwrap(),
        QuotaHeld {
            used: 0,
            ceiling: 0,
            ..
        }
    ));
    let held = snapshot(&pool, &r.binding.run_id).await;
    assert_eq!(held["status"], "paused");
    assert_eq!(held["context_snapshot"]["session"], old["session"]);
    assert_eq!(integer(&held["transition_count"], MAX_LIMIT), Some(0));
    assert_eq!(
        held["context_snapshot"]["quota_hold"]["request"],
        serde_json::to_value(&r).unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transition_quota_receipts WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transition_quota_periods WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert!(GatewaySession::from_checkpoint(
        held["context_snapshot"].clone(),
        "quota-session",
        "ready"
    )
    .is_err());
    assert!(matches!(
        admit_or_hold(&pool, &r).await.unwrap(),
        ResumeRequired { .. }
    ));
    assert!(matches!(
        continue_held_admission(&pool, &r.binding).await.unwrap(),
        QuotaHeld {
            used: 0,
            ceiling: 0,
            ..
        }
    ));
    for field in [
        "owner",
        "session",
        "project",
        "run",
        "revision",
        "operation",
        "digest",
    ] {
        let mut foreign = r.binding.clone();
        match field {
            "owner" => foreign.owner = "foreign".into(),
            "session" => foreign.session_id = "foreign".into(),
            "project" => foreign.project_id = "foreign".into(),
            "run" => foreign.run_id = "foreign".into(),
            "revision" => foreign.expected_transition_count = 1,
            "operation" => foreign.operation_id = "foreign".into(),
            _ => foreign.request_digest = "b".repeat(64),
        };
        let result = continue_held_admission(&pool, &foreign).await.unwrap();
        assert!(
            matches!(result, BindingConflict | StaleOrForeignRun),
            "{field}: {result:?}"
        );
    }
    let mut changed = r.clone();
    changed.event = "DONE".into();
    assert_eq!(
        admit_or_hold(&pool, &changed).await.unwrap(),
        BindingConflict
    );
    // Upgrade/disabled accounting cannot silently resume the old event.
    sqlx::query("UPDATE transition_quota_rollout SET active=false")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        continue_held_admission(&pool, &r.binding).await.unwrap(),
        AccountingInactive
    );
    sqlx::query("UPDATE transition_quota_rollout SET active=true")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE plans SET steps_included=200 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        persist_durable_admission(&pool, &r).await.unwrap(),
        ResumeRequired { .. }
    ));
    // Changed authority cannot replay the target or erase independent approval.
    let intact = snapshot(&pool, &r.binding.run_id).await["context_snapshot"].clone();
    for field in [
        "schema",
        "owner",
        "run_id",
        "session_id",
        "project_id",
        "expected_transition_count",
    ] {
        let mut corrupted = intact.clone();
        if field == "schema" {
            corrupted["quota_hold"][field] = json!("unknown");
        } else {
            corrupted["quota_hold"]["request"]["binding"][field] =
                if field == "expected_transition_count" {
                    json!(1)
                } else {
                    json!("foreign")
                };
        }
        sqlx::query("UPDATE workflow_runs SET context_snapshot=$1 WHERE id=$2")
            .bind(&corrupted)
            .bind(&r.binding.run_id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            continue_held_admission(&pool, &r.binding).await.unwrap(),
            InvalidCheckpoint,
            "{field}"
        );
        let mut other = r.clone();
        other.binding.operation_id = "new-operation".into();
        assert_eq!(
            admit_or_hold(&pool, &other).await.unwrap(),
            InvalidCheckpoint,
            "{field}"
        );
    }
    let mut altered = intact.clone();
    altered["session"]["context"] = json!({"x":999});
    sqlx::query("UPDATE workflow_runs SET context_snapshot=$1 WHERE id=$2")
        .bind(&altered)
        .bind(&r.binding.run_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        continue_held_admission(&pool, &r.binding).await.unwrap(),
        InvalidCheckpoint,
        "a held event must not overwrite same-revision manual edits even to the same key"
    );
    altered = intact.clone();
    altered["session"]["context"] = json!({"manual_change":true});
    sqlx::query("UPDATE workflow_runs SET context_snapshot=$1 WHERE id=$2")
        .bind(&altered)
        .bind(&r.binding.run_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        continue_held_admission(&pool, &r.binding).await.unwrap(),
        InvalidCheckpoint
    );
    altered = intact.clone();
    altered["session"]["pending_approval"] = json!({"approval_id":"independent","event":"DONE","from_state":"ready","to_state":"done","new_context":{},"message":null});
    sqlx::query("UPDATE workflow_runs SET context_snapshot=$1 WHERE id=$2")
        .bind(&altered)
        .bind(&r.binding.run_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        continue_held_admission(&pool, &r.binding).await.unwrap(),
        InvalidCheckpoint
    );
    assert_eq!(
        snapshot(&pool, &r.binding.run_id).await["context_snapshot"],
        altered
    );
    sqlx::query("UPDATE workflow_runs SET context_snapshot=$1 WHERE id=$2")
        .bind(&intact)
        .bind(&r.binding.run_id)
        .execute(&pool)
        .await
        .unwrap();
    // Fresh connection reconstructs from durable data, not a captured closure.
    pool.close().await;
    pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        continue_held_admission(&pool, &r.binding),
        continue_held_admission(&pool, &r.binding)
    );
    let results = [a.unwrap(), b.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Applied { used_after: 1, .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Duplicate { used_after: 1, .. }))
            .count(),
        1
    );
    let resumed = snapshot(&pool, &r.binding.run_id).await;
    assert_eq!(resumed["context_snapshot"], r.candidate_checkpoint);
    assert_eq!(resumed["status"], "running");
    assert_eq!(
        cancel_held_admission(&pool, &r.binding).await.unwrap(),
        AlreadyApplied
    );

    // Cancellation never consumes usage and remains idempotent.
    sqlx::query("UPDATE plans SET steps_included=0 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    let mut cancel = r.clone();
    cancel.binding.run_id = "quota_holdrun002".into();
    cancel.binding.operation_id = "cancel-held".into();
    assert!(matches!(
        admit_or_hold(&pool, &cancel).await.unwrap(),
        QuotaHeld { .. }
    ));
    for _ in 0..2 {
        assert_eq!(
            cancel_held_admission(&pool, &cancel.binding).await.unwrap(),
            Cancelled
        );
    }
    assert_eq!(
        snapshot(&pool, &cancel.binding.run_id).await["status"],
        "stopped"
    );
    assert_eq!(
        continue_held_admission(&pool, &cancel.binding)
            .await
            .unwrap(),
        StaleOrForeignRun
    );

    // Receipt failure after checkpoint/counter writes rolls the entire resume back.
    let mut rollback = r.clone();
    rollback.binding.run_id = "quota_holdrun003".into();
    rollback.binding.operation_id = "receipt-fail".into();
    assert!(matches!(
        admit_or_hold(&pool, &rollback).await.unwrap(),
        QuotaHeld { .. }
    ));
    let before = snapshot(&pool, &rollback.binding.run_id).await;
    sqlx::query("UPDATE plans SET steps_included=200 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE FUNCTION quota_fixture_receipt_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER quota_fixture_receipt_skip BEFORE INSERT ON transition_quota_receipts FOR EACH ROW WHEN (NEW.operation_id='receipt-fail') EXECUTE FUNCTION quota_fixture_receipt_skip()").execute(&pool).await.unwrap();
    assert!(continue_held_admission(&pool, &rollback.binding)
        .await
        .is_err());
    assert_eq!(snapshot(&pool, &rollback.binding.run_id).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT used::bigint FROM transition_quota_periods WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    sqlx::query("DROP TRIGGER quota_fixture_receipt_skip ON transition_quota_receipts")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION quota_fixture_receipt_skip()")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        continue_held_admission(&pool, &rollback.binding)
            .await
            .unwrap(),
        Applied { used_after: 2, .. }
    ));
    assert!(matches!(
        continue_held_admission(&pool, &rollback.binding)
            .await
            .unwrap(),
        Duplicate { used_after: 2, .. }
    ));

    let mut terminal = successor(&pool, &r, "terminal").await;
    terminal.event = "DONE".into();
    terminal.candidate_checkpoint["session"]["current_state"] = json!("done");
    assert!(matches!(
        admit_or_hold(&pool, &terminal).await.unwrap(),
        Applied { used_after: 3, .. }
    ));
    let final_run = snapshot(&pool, &r.binding.run_id).await;
    assert_eq!(final_run["status"], "completed");
    assert!(date(string(&final_run, "completed_at")).is_some());
    assert!(matches!(
        continue_held_admission(&pool, &terminal.binding)
            .await
            .unwrap(),
        Duplicate { used_after: 3, .. }
    ));
    // Continue versus Cancel has a single winner, never a charge after cancel
    // or a cancellation that hides already admitted work.
    sqlx::query("UPDATE plans SET steps_included=0 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    let mut race = r.clone();
    race.binding.run_id = "quota_holdrun004".into();
    race.binding.operation_id = "continue-cancel-race".into();
    assert!(matches!(
        admit_or_hold(&pool, &race).await.unwrap(),
        QuotaHeld { .. }
    ));
    sqlx::query("UPDATE plans SET steps_included=200 WHERE name='Free'")
        .execute(&pool)
        .await
        .unwrap();
    let (continued, cancelled) = tokio::join!(
        continue_held_admission(&pool, &race.binding),
        cancel_held_admission(&pool, &race.binding)
    );
    let row = snapshot(&pool, &race.binding.run_id).await;
    let expected_used = match (continued.unwrap(), cancelled.unwrap()) {
        (Applied { used_after: 4, .. }, AlreadyApplied) => {
            assert_eq!(row["status"], "running");
            assert_eq!(row["context_snapshot"], race.candidate_checkpoint);
            4
        }
        (StaleOrForeignRun, Cancelled) => {
            assert_eq!(row["status"], "stopped");
            assert_eq!(row["context_snapshot"]["session"], old["session"]);
            3
        }
        other => panic!("invalid Continue/Cancel outcome: {other:?}"),
    };
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT used::bigint FROM transition_quota_periods WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        expected_used
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transition_quota_receipts WHERE owner=$1"
        )
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap(),
        expected_used
    );
    sqlx::query("DELETE FROM transition_quota_rollout WHERE id='quota_rollout01'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
