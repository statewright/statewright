use super::{
    auto_test_failure_signature, baseline_prove_repair_scope, causal_post_edit_can_audit,
    compact_test_telemetry, enforce_causal_serial_env, extract_paths_from_malformed,
    inspect_class_locations,
    is_stagnation_diagnostic_tool, malformed_response_path_diagnostics, parse_response,
    pre_completion_guard_failure, ranked_locus_excerpts, remaining_fanout_budget_seconds,
    restore_env, source_scope_ambiguous_candidate_count_with_window,
    test_collection_failure_unrelated_to_diff, test_collection_or_scope_failure,
    test_has_patch_blocking_collection_failure, test_passed,
    untrusted_scope_must_route_unavailable,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::process::Command;
use std::sync::Mutex;

static SW_TEST_CAN_COMPLETE_ENV_LOCK: Mutex<()> = Mutex::new(());
static ARTIFACT_ENV_LOCK: Mutex<()> = Mutex::new(());
static CAUSAL_SERIAL_ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn source_scope_validation_covers_near_tied_candidates_only() {
    let candidate = |path: &str, score| super::repair_feedback::ScopeCandidate {
        path: path.to_string(),
        score,
        reason: String::new(),
        authoritative: true,
    };
    let candidates = vec![
        candidate("pkg/a/tests/test_connect.py", 808),
        candidate("pkg/b/tests/test_connect.py", 806),
        candidate("pkg/c/tests/test_connect.py", 700),
    ];

    assert_eq!(
        source_scope_ambiguous_candidate_count_with_window(&candidates, 24),
        2
    );
    assert_eq!(
        source_scope_ambiguous_candidate_count_with_window(&candidates, 1),
        1
    );
}

#[test]
fn causal_audit_requires_task_efficacy_not_regression_safety_alone() {
    use super::causal_validation::CausalScopeSignal;
    use super::validation_oracle::TestDelta;

    assert!(causal_post_edit_can_audit(
        true,
        Some(TestDelta::Fixed),
        CausalScopeSignal::RegressionPass,
    ));
    assert!(!causal_post_edit_can_audit(
        true,
        Some(TestDelta::UnchangedFail),
        CausalScopeSignal::RegressionPass,
    ));
    assert!(!causal_post_edit_can_audit(
        true,
        None,
        CausalScopeSignal::RegressionPass,
    ));
    assert!(!causal_post_edit_can_audit(
        false,
        None,
        CausalScopeSignal::RegressionPass,
    ));
    assert!(causal_post_edit_can_audit(
        false,
        None,
        CausalScopeSignal::TaskScopeImproved,
    ));
    assert!(!causal_post_edit_can_audit(
        false,
        None,
        CausalScopeSignal::RegressionFailure,
    ));
}

#[test]
fn causal_untrusted_failures_steer_repair_but_never_certify_a_pass() {
    let failed =
        "SW_TEST_EXIT_CODE=1\nSW_TEST_SCOPE_TRUSTED=0\nFAILED tests/test_widget.py::test_shape\n";
    let passed = "SW_TEST_EXIT_CODE=0\nSW_TEST_SCOPE_TRUSTED=0\n1 passed\n";

    assert!(!untrusted_scope_must_route_unavailable(true, failed));
    assert!(untrusted_scope_must_route_unavailable(true, passed));
    assert!(untrusted_scope_must_route_unavailable(false, failed));
}

#[test]
fn fanout_budget_reserves_canonical_verification_time() {
    assert_eq!(remaining_fanout_budget_seconds(9_600, 600, 0), 9_000);
    assert_eq!(remaining_fanout_budget_seconds(9_600, 600, 300), 8_700);
    assert_eq!(remaining_fanout_budget_seconds(500, 600, 0), 60);
}

fn preferred_scoped_test_file(test_files: &str) -> Option<String> {
    let files: Vec<&str> = test_files.split(':').filter(|f| !f.is_empty()).collect();
    files
        .iter()
        .min_by_key(|path| super::scoped_test_path_rank(path))
        .map(|path| path.to_string())
}

fn issue_scope_tokens(task: &str, explicit_source_paths: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    super::push_scope_tokens(task, &mut tokens);
    for path in explicit_source_paths {
        super::push_scope_tokens(path, &mut tokens);
    }
    tokens
}

fn test_scope_tokens(path: Option<&str>, label: Option<&str>) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(path) = path {
        super::push_scope_tokens(path, &mut tokens);
    }
    if let Some(label) = label {
        super::push_scope_tokens(label, &mut tokens);
    }
    tokens
}

fn test_scope_correlates_with_issue(
    task: &str,
    explicit_source_paths: &[String],
    path: Option<&str>,
    label: Option<&str>,
) -> bool {
    let issue_tokens = issue_scope_tokens(task, explicit_source_paths);
    if issue_tokens.is_empty() {
        return false;
    }
    let scope_tokens = test_scope_tokens(path, label);
    scope_tokens
        .iter()
        .any(|scope| issue_tokens.iter().any(|issue| issue == scope))
}

#[test]
fn test_passed_requires_zero_exit_code() {
    let output = "SW_TEST_EXIT_CODE=1\n---\n42 passed, 1 exceptions\n";
    assert!(!test_passed(output));
}

#[test]
fn artifact_writers_create_json_and_jsonl() {
    let _guard = ARTIFACT_ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let previous = std::env::var("SW_ARTIFACT_DIR").ok();
    unsafe {
        std::env::set_var("SW_ARTIFACT_DIR", dir.path());
    }

    super::write_json_artifact("probe.json", &json!({"ok": true}));
    super::append_jsonl_artifact("events.jsonl", &json!({"event": "probe"}));

    restore_env("SW_ARTIFACT_DIR", previous);
    let probe: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("probe.json")).unwrap()).unwrap();
    assert_eq!(probe["ok"], true);
    let events = fs::read_to_string(dir.path().join("events.jsonl")).unwrap();
    assert!(events.contains("\"event\":\"probe\""), "{}", events);
}

#[test]
fn load_run_config_reports_parse_errors_without_panicking() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("run-config.json");
    fs::write(&path, "{not json").expect("write config");

    let err = super::load_run_config_from_path(path.to_str().unwrap()).expect_err("parse error");

    assert!(err.contains("parse_failed"), "{}", err);
    assert!(err.contains("run-config.json"), "{}", err);
}

#[test]
fn test_passed_rejects_do_not_commit() {
    let output = "SW_TEST_EXIT_CODE=0\n---\n42 passed\nDO *NOT* COMMIT!\n";
    assert!(!test_passed(output));
}

#[test]
fn patch_blocking_collection_failure_detects_syntax_and_collection_errors() {
    assert!(test_has_patch_blocking_collection_failure(
        "SW_TEST_EXIT_CODE=4\nERROR collecting sklearn/base.py\nSyntaxError: invalid syntax\n"
    ));
    assert!(test_has_patch_blocking_collection_failure(
        "SW_TEST_EXIT_CODE=4\nImportError while loading conftest\n"
    ));
    assert!(!test_has_patch_blocking_collection_failure(
        "SW_TEST_EXIT_CODE=1\nFAILED tests/test_lib.py::test_expected_assertion\nE   assert 1 == 2\n"
    ));
}

#[test]
fn pre_completion_guard_blocks_changed_python_syntax_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let workdir = dir.path();
    fs::create_dir_all(workdir.join("sklearn")).unwrap();
    fs::write(
        workdir.join("sklearn/base.py"),
        "def check_estimator(estimator):\n    return estimator\n",
    )
    .unwrap();
    assert!(
        Command::new("git")
            .arg("init")
            .current_dir(workdir)
            .status()
            .expect("git init")
            .success()
    );
    assert!(
        Command::new("git")
            .args(["add", "sklearn/base.py"])
            .current_dir(workdir)
            .status()
            .expect("git add")
            .success()
    );
    assert!(
        Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(workdir)
            .status()
            .expect("git commit")
            .success()
    );

    fs::write(
        workdir.join("sklearn/base.py"),
        "def check_estimator(estimator)\n    return estimator\n",
    )
    .unwrap();

    let feedback = pre_completion_guard_failure(
        workdir.to_str().unwrap(),
        &[],
        "scikit-learn syntax regression",
        "qwen3:8b",
        None,
    )
    .expect("guard feedback");
    assert!(feedback.contains("[PRE_COMPLETION_GUARD] FAIL"));
    assert!(feedback.contains("kind=python_syntax"));
    assert!(feedback.contains("sklearn/base.py"));
    assert!(feedback.contains("SyntaxError"));
}

#[test]
fn baseline_probe_restores_candidate_after_public_scope_check() {
    let _guard = SW_TEST_CAN_COMPLETE_ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let workdir = dir.path();
    fs::create_dir_all(workdir.join("tests")).unwrap();
    fs::write(workdir.join("src.py"), "value = 1\n").unwrap();
    fs::write(
        workdir.join("tests/test_src.py"),
        "# public test placeholder\n",
    )
    .unwrap();
    fs::write(
            workdir.join("check.py"),
            "import pathlib, sys\ntext = pathlib.Path('src.py').read_text()\nsys.exit(0 if 'value = 1' in text else 1)\n",
        )
        .unwrap();

    let baseline = super::tools::snapshot_all(workdir.to_str().unwrap());
    fs::write(workdir.join("src.py"), "value = 2\n").unwrap();

    let previous = [
        ("SW_TEST_CMD", std::env::var("SW_TEST_CMD").ok()),
        (
            "SW_TEST_CAN_COMPLETE",
            std::env::var("SW_TEST_CAN_COMPLETE").ok(),
        ),
        (
            "SW_TEST_SCOPE_AUTHORITY",
            std::env::var("SW_TEST_SCOPE_AUTHORITY").ok(),
        ),
        (
            "SW_TEST_SCOPE_TRUSTED",
            std::env::var("SW_TEST_SCOPE_TRUSTED").ok(),
        ),
        (
            "SW_SCOPE_BASELINE_PROBE",
            std::env::var("SW_SCOPE_BASELINE_PROBE").ok(),
        ),
    ];
    unsafe {
        std::env::set_var("SW_TEST_CMD", "python3 check.py");
        std::env::set_var("SW_SCOPE_BASELINE_PROBE", "1");
    }

    let proved = baseline_prove_repair_scope(
        &json!({"path": "tests/test_src.py"}),
        "SOURCE_SCOPE_TEST_FILES=tests/test_src.py",
        &["tests/test_src.py".to_string()],
        workdir.to_str().unwrap(),
        Some(&baseline),
    );

    for (name, value) in previous {
        restore_env(name, value);
    }

    assert!(proved);
    assert_eq!(
        fs::read_to_string(workdir.join("src.py")).unwrap(),
        "value = 2\n"
    );
}

#[test]
fn test_passed_accepts_clean_zero_exit() {
    let output = "SW_TEST_EXIT_CODE=0\n---\n42 passed in 0.42s\n";
    assert!(test_passed(output));
}

#[test]
fn test_passed_rejects_untrusted_harness_scope() {
    let output = "SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_PATCH_STATUS=failed\n---\nRan 12 tests\n\nOK\n";
    assert!(!test_passed(output));
}

#[test]
fn feedback_scope_is_raw_pass_but_not_completion_authority() {
    let output = "SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_AUTHORITY=feedback\nSW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\n---\n1 passed\n";
    assert!(!super::test_scope_untrusted(output));
    assert!(test_passed(output));
    assert!(!super::test_scope_can_complete(output));
}

#[test]
fn test_passed_accepts_django_ok_format() {
    // Django runtests.py outputs "Ran N tests in Xs\n\nOK" — no "passed" string.
    // Previously test_passed returned false here, causing 0/10 on all Django instances.
    let output = "System check identified no issues (0 silenced).\n\
                      Ran 5 tests in 0.012s\n\n\
                      OK\n\
                      SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\n";
    assert!(test_passed(output));
}

#[test]
fn test_passed_rejects_zero_test_django_ok_format() {
    let output = "System check identified no issues (0 silenced).\n\
                      Ran 0 tests in 0.000s\n\n\
                      OK\n\
                      SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\n";
    assert!(!test_passed(output));
}

#[test]
fn test_passed_rejects_django_fail() {
    // Django failing test: exit 1 + "FAILED" in output
    let output = "FAIL: test_bulk_update (queries.tests.BulkUpdateTests)\n\
                      AssertionError: 0 != 2\n\
                      Ran 5 tests in 0.012s\n\n\
                      FAILED (failures=1)\n\
                      SW_TEST_EXIT_CODE=1\nSW_TEST_ENV_UNAVAILABLE=0\n";
    assert!(!test_passed(output));
}

#[test]
fn parse_response_heals_missing_tool_call_close_brace() {
    // qwen3:8b consistently omits the closing } for tool_call objects before ].
    // Model emits: {"tool_calls": [{"name": "insert_between", "args": {...}], "transition": "DONE"}
    //   (missing }  before ] — the tool_call object is never closed)
    let raw = r#"{"tool_calls": [{"name": "insert_between", "args": {"path": "django/db/models/enums.py", "after": "class Choices(", "new": "    do_not_call_in_templates = True"}], "transition": "DONE"}]}"#;
    let result = parse_response(raw);
    assert!(
        result.is_some(),
        "should heal missing tool_call closing brace"
    );
    let r = result.unwrap();
    assert_eq!(r.transition.as_deref(), Some("DONE"));
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "insert_between");
}

#[test]
fn parse_response_heals_is_idempotent_on_valid_json() {
    // Valid JSON with proper }}] should parse without healing (at direct-parse step)
    let raw = r#"{"tool_calls": [{"name": "edit_line", "args": {"path": "f.py", "old": "x", "new": "y"}}], "transition": "DONE"}"#;
    let result = parse_response(raw);
    assert!(result.is_some());
    let r = result.unwrap();
    assert_eq!(r.transition.as_deref(), Some("DONE"));
}

#[test]
fn malformed_response_path_extraction_handles_spaced_json() {
    let raw = r#"{"tool_calls": [{"name": "edit_line", "args": {"path": "your_app/models.py", "old": "x", "new": "y"}}]}"#;
    assert_eq!(
        extract_paths_from_malformed(raw),
        vec!["your_app/models.py".to_string()]
    );
}

#[test]
fn malformed_response_path_diagnostics_flag_nonexistent_paths_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/db/models")).unwrap();
    fs::write(
        dir.path().join("django/db/models/query.py"),
        "class Query:\n",
    )
    .unwrap();

    let raw = r#"{"tool_calls": [
          {"name": "edit_line", "args": {"path": "django/db/models/query.py", "old": "x", "new": "y"}},
          {"name": "edit_line", "args": {"path": "your_app/models.py", "old": "x", "new": "y"}}
        ]"#;
    let diagnostics = malformed_response_path_diagnostics(raw, dir.path().to_str().unwrap());
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].contains("your_app/models.py"));
    assert!(diagnostics[0].contains("not an existing file"));
}

#[test]
fn safe_test_scope_extraction_requires_existing_repo_test_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("tests/delete")).unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("tests/delete/tests.py"),
        "def test_x(): pass\n",
    )
    .unwrap();
    fs::write(dir.path().join("src/helper.py"), "x = 1\n").unwrap();

    let output = "\
FAILED tests/delete/tests.py::DeleteTests::test_collector\n\
/tmp/outside/tests/test_secret.py::test_hidden\n\
your_app/tests.py::test_missing\n\
src/helper.py::test_not_selected\n\
python3 tests/runtests.py --verbosity=1 delete.tests\n";
    let selected = super::extract_safe_test_files_from_output(dir.path().to_str().unwrap(), output);

    assert_eq!(selected, vec!["tests/delete/tests.py".to_string()]);
}

#[test]
fn safe_test_scope_extraction_derives_django_label_and_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("tests/backends/sqlite")).unwrap();
    fs::write(
        dir.path().join("tests/backends/sqlite/tests.py"),
        "class SchemaTests:\n    def test_reserved_table_name(self): pass\n",
    )
    .unwrap();

    let output = "\
FAIL: test_reserved_table_name (backends.sqlite.tests.SchemaTests.test_reserved_table_name)\n\
Traceback (most recent call last):\n\
sqlite3.OperationalError: near \"order\": syntax error\n";

    let files = super::extract_safe_test_files_from_output(dir.path().to_str().unwrap(), output);
    let labels = super::extract_safe_test_labels_from_output(dir.path().to_str().unwrap(), output);

    assert_eq!(files, vec!["tests/backends/sqlite/tests.py".to_string()]);
    assert_eq!(
        labels,
        vec!["backends.sqlite.tests.SchemaTests.test_reserved_table_name".to_string()]
    );
}

#[test]
fn test_scope_from_files_builds_primary_path_with_extra_args() {
    let files = vec![
        "tests/test_alpha.py".to_string(),
        "tests/test_beta.py".to_string(),
    ];
    let (scope, desc) = super::test_scope_from_files(&files, "DISCOVERY_TEST_FILES");

    assert_eq!(
        scope.get("path").and_then(|value| value.as_str()),
        Some("tests/test_alpha.py")
    );
    assert_eq!(
        scope
            .get("args")
            .and_then(|value| value.as_array())
            .and_then(|values| values.first())
            .and_then(|value| value.as_str()),
        Some("tests/test_beta.py")
    );
    assert_eq!(desc, "DISCOVERY_TEST_FILES=tests/test_alpha.py (+1 more)");
}

#[test]
fn test_scope_from_labels_builds_primary_label_with_extra_args() {
    let labels = vec![
        "backends.sqlite.tests.SchemaTests.test_reserved_table_name".to_string(),
        "backends.sqlite.tests.SchemaTests.test_table_names".to_string(),
    ];
    let (scope, desc) = super::test_scope_from_labels(&labels, "DISCOVERY_TEST_LABELS");

    assert_eq!(
        scope.get("label").and_then(|value| value.as_str()),
        Some("backends.sqlite.tests.SchemaTests.test_reserved_table_name")
    );
    assert_eq!(
        scope
            .get("args")
            .and_then(|value| value.as_array())
            .and_then(|values| values.first())
            .and_then(|value| value.as_str()),
        Some("backends.sqlite.tests.SchemaTests.test_table_names")
    );
    assert_eq!(
        desc,
        "DISCOVERY_TEST_LABELS=backends.sqlite.tests.SchemaTests.test_reserved_table_name (+1 more)"
    );
}

#[test]
fn test_scope_correlation_rejects_unrelated_django_baseline_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("tests/requests")).unwrap();
    fs::create_dir_all(dir.path().join("tests/backends/sqlite")).unwrap();
    fs::write(
        dir.path()
            .join("tests/requests/test_data_upload_settings.py"),
        "class DataUploadMaxNumberOfFieldsFormPost:\n    pass\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("tests/backends/sqlite/tests.py"),
        "class SchemaTests:\n    def test_reserved_table_name(self): pass\n",
    )
    .unwrap();

    let task = "loaddata crashes on SQLite when table names are SQL keywords. \
            Root cause: django/db/backends/sqlite3/base.py check_constraints \
            does not quote PRAGMA foreign_key_check(order).";
    let explicit_source_paths = vec!["django/db/backends/sqlite3/base.py".to_string()];
    let unrelated_label = "requests.test_data_upload_settings.DataUploadMaxNumberOfFieldsFormPost";
    let unrelated_path =
        super::django_label_test_file(dir.path().to_str().unwrap(), unrelated_label);

    assert_eq!(
        unrelated_path.as_deref(),
        Some("tests/requests/test_data_upload_settings.py")
    );
    assert!(!test_scope_correlates_with_issue(
        task,
        &explicit_source_paths,
        unrelated_path.as_deref(),
        Some(unrelated_label),
    ));

    let correlated_label = "backends.sqlite.tests.SchemaTests.test_reserved_table_name";
    let correlated_path =
        super::django_label_test_file(dir.path().to_str().unwrap(), correlated_label);
    assert!(test_scope_correlates_with_issue(
        task,
        &explicit_source_paths,
        correlated_path.as_deref(),
        Some(correlated_label),
    ));
}

#[test]
fn source_locus_test_candidates_map_python_package_tests() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("sklearn/linear_model/tests")).unwrap();
    fs::create_dir_all(dir.path().join("sklearn/cluster/tests")).unwrap();
    fs::write(dir.path().join("sklearn/linear_model/huber.py"), "").unwrap();
    fs::write(
        dir.path().join("sklearn/linear_model/tests/test_huber.py"),
        "def test_huber(): pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("sklearn/cluster/tests/test_affinity_propagation.py"),
        "def test_cluster(): pass\n",
    )
    .unwrap();

    let all_files = vec![
        "sklearn/linear_model/huber.py".to_string(),
        "sklearn/linear_model/tests/test_huber.py".to_string(),
        "sklearn/cluster/tests/test_affinity_propagation.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["sklearn/linear_model/huber.py".to_string()],
        &all_files,
        "HuberRegressor epsilon should be validated",
    );

    assert_eq!(candidates.len(), 1, "candidates: {candidates:#?}");
    assert_eq!(
        candidates[0].path,
        "sklearn/linear_model/tests/test_huber.py"
    );
}

#[test]
fn source_locus_test_candidates_map_astropy_nested_module_to_package_tests() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("astropy/nddata/mixins")).unwrap();
    fs::create_dir_all(dir.path().join("astropy/nddata/tests")).unwrap();
    fs::create_dir_all(dir.path().join("astropy/table/tests")).unwrap();
    fs::write(
        dir.path().join("astropy/nddata/mixins/ndarithmetic.py"),
        "class NDArithmeticMixin: pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("astropy/nddata/tests/test_nddata_operators.py"),
        "def test_nddata_arithmetic_quantity():\n    assert 'NDArithmeticMixin'\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/table/tests/test_table.py"),
        "def test_table_noise(): pass\n",
    )
    .unwrap();

    let all_files = vec![
        "astropy/nddata/mixins/ndarithmetic.py".to_string(),
        "astropy/nddata/tests/test_nddata_operators.py".to_string(),
        "astropy/table/tests/test_table.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["astropy/nddata/mixins/ndarithmetic.py".to_string()],
        &all_files,
        "NDData arithmetic should preserve units when using NDArithmeticMixin",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path,
        "astropy/nddata/tests/test_nddata_operators.py"
    );
    assert!(
        candidates[0]
            .reason
            .contains("test references source symbol(s)")
    );
}

#[test]
fn source_locus_test_candidates_map_astropy_cython_sources_to_package_tests() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("astropy/table")).unwrap();
    fs::create_dir_all(dir.path().join("astropy/table/tests")).unwrap();
    fs::create_dir_all(dir.path().join("astropy/io/fits/tests")).unwrap();
    fs::write(
        dir.path().join("astropy/table/_column_mixins.pyx"),
        "cdef class ColumnMixin: pass\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/table/tests/test_mixin.py"),
        "def test_mixin_structured_column():\n    assert 'ColumnMixin'\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_header.py"),
        "def test_header_noise(): pass\n",
    )
    .unwrap();

    let all_files = vec![
        "astropy/table/_column_mixins.pyx".to_string(),
        "astropy/table/tests/test_mixin.py".to_string(),
        "astropy/io/fits/tests/test_header.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["astropy/table/_column_mixins.pyx".to_string()],
        &all_files,
        "Table ColumnMixin should preserve structured array mixin behavior",
    );

    assert!(!candidates.is_empty());
    assert_eq!(candidates[0].path, "astropy/table/tests/test_mixin.py");
    assert!(
        candidates[0]
            .reason
            .contains("test references source symbol(s)")
    );
}

#[test]
fn feedback_source_locus_candidates_prioritize_explicit_sources() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("sklearn/linear_model/tests")).unwrap();
    fs::create_dir_all(dir.path().join("sklearn/ensemble/tests")).unwrap();
    fs::write(dir.path().join("sklearn/linear_model/huber.py"), "").unwrap();
    fs::write(dir.path().join("sklearn/ensemble/gradient_boosting.py"), "").unwrap();
    fs::write(
        dir.path().join("sklearn/linear_model/tests/test_huber.py"),
        "def test_huber_bool_data():\n    HuberRegressor\n    X_bool\n",
    )
    .unwrap();
    fs::write(
            dir.path()
                .join("sklearn/ensemble/tests/test_gradient_boosting.py"),
            "def test_gradient_boosting_noise():\n    HuberRegressor\n    X_bool\n    sample_weight\n    dict_\n",
        )
        .unwrap();

    let all_files = vec![
        "sklearn/linear_model/huber.py".to_string(),
        "sklearn/ensemble/gradient_boosting.py".to_string(),
        "sklearn/linear_model/tests/test_huber.py".to_string(),
        "sklearn/ensemble/tests/test_gradient_boosting.py".to_string(),
    ];
    let ranked_files = vec![
        ("sklearn/ensemble/gradient_boosting.py".to_string(), 250),
        ("sklearn/linear_model/huber.py".to_string(), 100),
    ];
    let candidates = super::feedback_source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["sklearn/linear_model/huber.py".to_string()],
        &ranked_files,
        5,
        false,
        &all_files,
        "HuberRegressor fails with X_bool in sklearn/linear_model/huber.py",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path,
        "sklearn/linear_model/tests/test_huber.py"
    );
    assert!(
        candidates
            .iter()
            .any(|candidate| candidate.path == "sklearn/ensemble/tests/test_gradient_boosting.py"),
        "ranked-neighbor scope remains available as fallback"
    );
}

#[test]
fn source_locus_test_candidates_rank_astropy_card_header_tests_over_generic_siblings() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("astropy/io/fits/tests")).unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/card.py"),
        "class Card: pass\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_connect.py"),
        "def test_round_trip():\n    comment = 'generic comment behavior'\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_core.py"),
        "def test_core_comment():\n    comments = []\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_diff.py"),
        "def test_diff_contains_comment():\n    assert 'comment'\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_header.py"),
        "from astropy.io import fits\n\
             def test_floating_point_value_card():\n\
                 c = fits.Card('HIERARCH ABC DEF GH IJKLMN', 0.009125, 'radius comment')\n\
                 assert '0.009125' in str(c)\n\
             def test_invalid_float_cards2():\n\
                 card = fits.Card('TEST', 5.0022221e-07)\n\
                 assert 'E' in str(card) or 'e' in str(card)\n",
    )
    .unwrap();

    let all_files = vec![
        "astropy/io/fits/card.py".to_string(),
        "astropy/io/fits/tests/test_connect.py".to_string(),
        "astropy/io/fits/tests/test_core.py".to_string(),
        "astropy/io/fits/tests/test_diff.py".to_string(),
        "astropy/io/fits/tests/test_header.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["astropy/io/fits/card.py".to_string()],
        &all_files,
        "`io.fits.Card` expands 0.009125 to 0.009124999999999999 and truncates comments; root issue is astropy/io/fits/card.py _format_float",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path, "astropy/io/fits/tests/test_header.py",
        "candidates: {candidates:#?}"
    );
    assert!(
        candidates[0]
            .reason
            .contains("test references source stem `card`")
    );
    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| candidate.path == "astropy/io/fits/tests/test_connect.py")
    {
        assert_ne!(
            candidate.trust_tier, "issue_local",
            "generic prose matches like comment/behavior must not become issue-local scope"
        );
        assert!(
            candidate.score < candidates[0].score,
            "generic sibling scope must stay below source-stem header tests"
        );
    }
}

#[test]
fn source_locus_test_candidates_do_not_let_broad_issue_tokens_outrank_dense_source_tests() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("astropy/io/fits/tests")).unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/card.py"),
        "class Card:\n    def _format_float(self): pass\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_hdulist.py"),
        "from astropy.io import fits\n\
             def test_hdulist_noise():\n\
                 # broad issue words appear here but this is not Card formatting coverage\n\
                 assert 'astropy'\n\
                 assert 'combinations'\n\
                 assert 'essentially'\n\
                 card = fits.Card('A', 1)\n\
                 card = fits.Card('B', 2)\n\
                 card = fits.Card('C', 3)\n\
                 card = fits.Card('D', 4)\n\
                 card = fits.Card('E', 5)\n\
                 card = fits.Card('F', 6)\n\
                 card = fits.Card('G', 7)\n\
                 card = fits.Card('H', 8)\n",
    )
    .unwrap();
    let dense_card_mentions = "card ".repeat(80);
    fs::write(
        dir.path().join("astropy/io/fits/tests/test_header.py"),
        format!(
            "from astropy.io import fits\n\
             # {}\n\
             def test_header_cards():\n\
                 card = fits.Card('A', 1)\n\
                 cards = [fits.Card(str(i), i) for i in range(25)]\n\
                 assert all(str(card) for card in cards)\n",
            dense_card_mentions
        ),
    )
    .unwrap();

    let all_files = vec![
        "astropy/io/fits/card.py".to_string(),
        "astropy/io/fits/tests/test_hdulist.py".to_string(),
        "astropy/io/fits/tests/test_header.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["astropy/io/fits/card.py".to_string()],
        &all_files,
        "`io.fits.Card` expands 0.009125 to 0.009124999999999999 and truncates comments; root issue is astropy/io/fits/card.py _format_float",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path, "astropy/io/fits/tests/test_header.py",
        "candidates: {candidates:#?}"
    );
}

#[test]
fn source_locus_test_candidates_rank_issue_symbol_hits() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/db/models/fields")).unwrap();
    fs::create_dir_all(dir.path().join("tests/check_framework")).unwrap();
    fs::create_dir_all(dir.path().join("tests/m2m_through")).unwrap();
    fs::write(
        dir.path()
            .join("django/db/models/fields/reverse_related.py"),
        "class ManyToManyRel:\n    pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("tests/check_framework/test_model_checks.py"),
        "def test_model_checks(): pass\n",
    )
    .unwrap();
    fs::write(
            dir.path().join("tests/m2m_through/tests.py"),
            "def test_reverse_inherited_m2m_with_through_fields_list_hashable():\n    assert through_fields\n    assert make_hashable\n",
        )
        .unwrap();

    let all_files = vec![
        "django/db/models/fields/reverse_related.py".to_string(),
        "tests/check_framework/test_model_checks.py".to_string(),
        "tests/m2m_through/tests.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["django/db/models/fields/reverse_related.py".to_string()],
        &all_files,
        "ManyToManyRel.__hash__ fails when through_fields is a list; use make_hashable.",
    );

    assert!(!candidates.is_empty());
    assert_eq!(candidates[0].path, "tests/m2m_through/tests.py");
    assert_eq!(candidates[0].trust_tier, "issue_local");
    assert!(
        candidates[0]
            .reason
            .contains("test references issue/source identifier")
    );
}

#[test]
fn source_locus_test_candidates_rank_exact_sympy_module_above_symbol_noise() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("sympy/functions/elementary/tests")).unwrap();
    fs::write(
        dir.path().join("sympy/functions/elementary/hyperbolic.py"),
        "def coth(x):\n    return x\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("sympy/functions/elementary/tests/test_hyperbolic.py"),
        "def test_coth_rewrite():\n    assert coth(x)\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("sympy/functions/elementary/tests/test_miscellaneous.py"),
        "def test_complex_infinity():\n    assert ComplexInfinity\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("sympy/functions/elementary/tests/test_complexes.py"),
        "def test_complex_infinity_rewrite():\n    assert ComplexInfinity\n",
    )
    .unwrap();

    let all_files = vec![
        "sympy/functions/elementary/hyperbolic.py".to_string(),
        "sympy/functions/elementary/tests/test_hyperbolic.py".to_string(),
        "sympy/functions/elementary/tests/test_miscellaneous.py".to_string(),
        "sympy/functions/elementary/tests/test_complexes.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["sympy/functions/elementary/hyperbolic.py".to_string()],
        &all_files,
        "coth should preserve ComplexInfinity when rewriting hyperbolic expressions",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path,
        "sympy/functions/elementary/tests/test_hyperbolic.py"
    );
    assert_eq!(candidates[0].trust_tier, "source_exact");
}

#[test]
fn source_locus_test_candidates_prefer_exact_compound_source_over_generic_symbol_noise() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/http")).unwrap();
    fs::create_dir_all(dir.path().join("django/contrib/gis/gdal/prototypes")).unwrap();
    fs::create_dir_all(dir.path().join("tests/httpwrappers")).unwrap();
    fs::create_dir_all(dir.path().join("tests/gis_tests/gdal_tests")).unwrap();
    fs::write(
        dir.path().join("django/http/response.py"),
        "class HttpResponse:\n    pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("django/contrib/gis/gdal/prototypes/raster.py"),
        "def data(as_memoryview=False):\n    return as_memoryview\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("tests/httpwrappers/tests.py"),
        "def test_response_content():\n    response = object()\n    assert response\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("tests/gis_tests/gdal_tests/test_raster.py"),
        format!(
            "def test_raster_memoryview():\n    assert 'memoryview'\n{}\n",
            "raster\n".repeat(80)
        ),
    )
    .unwrap();

    let all_files = vec![
        "django/http/response.py".to_string(),
        "django/contrib/gis/gdal/prototypes/raster.py".to_string(),
        "tests/httpwrappers/tests.py".to_string(),
        "tests/gis_tests/gdal_tests/test_raster.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &[
            "django/http/response.py".to_string(),
            "django/contrib/gis/gdal/prototypes/raster.py".to_string(),
        ],
        &all_files,
        "HttpResponse doesn't handle memoryview objects.",
    );

    assert!(!candidates.is_empty());
    assert_eq!(
        candidates[0].path, "tests/httpwrappers/tests.py",
        "candidates: {candidates:#?}"
    );
    assert!(
        candidates[0]
            .reason
            .contains("issue names source compound `httpresponse`")
    );
}

#[test]
fn feedback_source_locus_test_candidates_do_not_promote_weak_tail_sources_by_default() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/http")).unwrap();
    fs::create_dir_all(dir.path().join("django/db/models/fields")).unwrap();
    fs::create_dir_all(dir.path().join("django/contrib/gis/gdal/prototypes")).unwrap();
    fs::create_dir_all(dir.path().join("tests/httpwrappers")).unwrap();
    fs::create_dir_all(dir.path().join("tests/gis_tests/gdal_tests")).unwrap();
    fs::write(
        dir.path().join("django/http/response.py"),
        "class HttpResponse:\n    pass\n",
    )
    .unwrap();
    fs::write(dir.path().join("django/db/models/fields/__init__.py"), "").unwrap();
    fs::write(
        dir.path()
            .join("django/contrib/gis/gdal/prototypes/raster.py"),
        "def data(as_memoryview=False):\n    return as_memoryview\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("tests/httpwrappers/tests.py"),
        "def test_response_content():\n    response = object()\n    assert response\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("tests/gis_tests/gdal_tests/test_raster.py"),
        format!(
            "def test_raster_memoryview():\n    assert 'memoryview'\n{}\n",
            "raster\n".repeat(80)
        ),
    )
    .unwrap();

    let all_files = vec![
        "django/http/response.py".to_string(),
        "django/db/models/fields/__init__.py".to_string(),
        "django/contrib/gis/gdal/prototypes/raster.py".to_string(),
        "tests/httpwrappers/tests.py".to_string(),
        "tests/gis_tests/gdal_tests/test_raster.py".to_string(),
    ];
    let ranked_files = vec![
        ("django/db/models/fields/__init__.py".to_string(), 7),
        ("django/http/response.py".to_string(), 6),
        (
            "django/contrib/gis/gdal/prototypes/raster.py".to_string(),
            5,
        ),
    ];
    let candidates = super::feedback_source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &[],
        &ranked_files,
        8,
        false,
        &all_files,
        "HttpResponse doesn't handle memoryview objects.",
    );

    assert!(
        candidates
            .iter()
            .any(|candidate| candidate.path == "tests/httpwrappers/tests.py")
    );
    assert!(
        !candidates
            .iter()
            .any(|candidate| candidate.path == "tests/gis_tests/gdal_tests/test_raster.py")
    );
}

#[test]
fn task_keyword_patterns_reject_contractions_as_localization_anchors() {
    let patterns =
        super::task_keyword_grep_patterns("HttpResponse doesn't handle memoryview objects.");

    assert!(patterns.iter().any(|pattern| pattern == "HttpResponse"));
    assert!(patterns.iter().any(|pattern| pattern == "memoryview"));
    assert!(
        !patterns
            .iter()
            .any(|pattern| pattern.to_ascii_lowercase().contains("doesn"))
    );
}

#[test]
fn task_keyword_patterns_ignore_template_system_details() {
    let patterns = super::task_keyword_grep_patterns(
        "ASCII table output to HTML ignores the `formats` argument.\n\
         ### System Details\n\
         print(astropy.__version__)\n\
         print(erfa.__version__)\n",
    );

    assert!(
        patterns
            .iter()
            .any(|pattern| pattern.eq_ignore_ascii_case("formats"))
    );
    assert!(
        !patterns
            .iter()
            .any(|pattern| pattern.to_ascii_lowercase().contains("version"))
    );
    assert!(
        !patterns
            .iter()
            .any(|pattern| pattern.to_ascii_lowercase().contains("erfa"))
    );
}

#[test]
fn feedback_test_scope_for_sources_uses_actual_edited_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("sklearn/mixture/tests")).unwrap();
    fs::create_dir_all(dir.path().join("sklearn/utils/tests")).unwrap();
    fs::write(dir.path().join("sklearn/mixture/gaussian_mixture.py"), "").unwrap();
    fs::write(
        dir.path()
            .join("sklearn/mixture/tests/test_gaussian_mixture.py"),
        "def test_gaussian_mixture(): pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("sklearn/utils/tests/test_estimator_checks.py"),
        "def test_unrelated(): pass\n",
    )
    .unwrap();

    let all_files = vec![
        "sklearn/mixture/gaussian_mixture.py".to_string(),
        "sklearn/mixture/tests/test_gaussian_mixture.py".to_string(),
        "sklearn/utils/tests/test_estimator_checks.py".to_string(),
    ];
    let (scope, desc) = super::feedback_test_scope_for_sources(
        dir.path().to_str().unwrap(),
        &["sklearn/mixture/gaussian_mixture.py".to_string()],
        &all_files,
        "GaussianMixture should persist labels",
        "EDITED_SOURCE_TEST_FILES",
    )
    .expect("edited source maps to tests");

    assert_eq!(
        scope.get("path").and_then(|value| value.as_str()),
        Some("sklearn/mixture/tests/test_gaussian_mixture.py")
    );
    assert!(desc.starts_with("EDITED_SOURCE_TEST_FILES="));
}

#[test]
fn source_locus_test_candidates_map_django_sqlite_backend() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/db/backends/sqlite3")).unwrap();
    fs::create_dir_all(dir.path().join("tests/backends/sqlite")).unwrap();
    fs::create_dir_all(dir.path().join("tests/requests")).unwrap();
    fs::write(dir.path().join("django/db/backends/sqlite3/base.py"), "").unwrap();
    fs::write(
        dir.path().join("tests/backends/sqlite/tests.py"),
        "class SchemaTests: pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("tests/requests/test_data_upload_settings.py"),
        "class DataUploadMaxNumberOfFieldsFormPost: pass\n",
    )
    .unwrap();

    let all_files = vec![
        "django/db/backends/sqlite3/base.py".to_string(),
        "tests/backends/sqlite/tests.py".to_string(),
        "tests/requests/test_data_upload_settings.py".to_string(),
    ];
    let candidates = super::source_locus_test_candidates(
        dir.path().to_str().unwrap(),
        &["django/db/backends/sqlite3/base.py".to_string()],
        &all_files,
        "loaddata crashes on SQLite SQL keyword table names",
    );

    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].path, "tests/backends/sqlite/tests.py");
    assert!(super::path_matches_source_candidate(
        "tests/backends/sqlite/tests.py",
        &candidates
    ));
    assert!(!super::path_matches_source_candidate(
        "tests/requests/test_data_upload_settings.py",
        &candidates
    ));
}

#[test]
fn feedback_scope_promotion_requires_source_locus_match() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("django/db/backends/sqlite3")).unwrap();
    fs::create_dir_all(dir.path().join("tests/backends/sqlite")).unwrap();
    fs::create_dir_all(dir.path().join("tests/requests")).unwrap();
    fs::write(dir.path().join("django/db/backends/sqlite3/base.py"), "").unwrap();
    fs::write(
        dir.path().join("tests/backends/sqlite/tests.py"),
        "class SchemaTests: pass\n",
    )
    .unwrap();
    fs::write(
        dir.path()
            .join("tests/requests/test_data_upload_settings.py"),
        "class DataUploadMaxNumberOfFieldsFormPost: pass\n",
    )
    .unwrap();

    let candidates = vec![super::SourceTestCandidate {
        path: "tests/backends/sqlite/tests.py".to_string(),
        score: 95,
        reason: "django/db/backends/sqlite3/base.py -> Django sqlite backend tests".to_string(),
        trust_tier: "edited_source_adjacent".to_string(),
    }];

    assert!(super::feedback_scope_matches_source_candidates(
        dir.path().to_str().unwrap(),
        Some(&["tests/backends/sqlite/tests.py".to_string()]),
        None,
        &candidates
    ));
    assert!(super::feedback_scope_matches_source_candidates(
        dir.path().to_str().unwrap(),
        None,
        Some("backends.sqlite.tests.SchemaTests"),
        &candidates
    ));
    assert!(!super::feedback_scope_matches_source_candidates(
        dir.path().to_str().unwrap(),
        Some(&["tests/requests/test_data_upload_settings.py".to_string()]),
        None,
        &candidates
    ));
    assert!(!super::feedback_scope_matches_source_candidates(
        dir.path().to_str().unwrap(),
        None,
        Some("requests.test_data_upload_settings.DataUploadMaxNumberOfFieldsFormPost"),
        &candidates
    ));
}

#[test]
fn missing_edit_path_repaired_from_single_grounded_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::create_dir_all(dir.path().join("tests")).unwrap();
    fs::write(dir.path().join("pkg/file.py"), "x = 1\n").unwrap();
    fs::write(
        dir.path().join("tests/test_file.py"),
        "def test_file(): pass\n",
    )
    .unwrap();

    let mut tool_args = json!({"old": "x = 1", "new": "x = 2"});
    let mut read_paths = HashSet::new();
    read_paths.insert("pkg/file.py".to_string());
    read_paths.insert("tests/test_file.py".to_string());
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();

    let repaired = super::repair_edit_path_argument(
        "edit_block",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        None,
        &HashSet::new(),
        None,
    )
    .expect("single grounded source path should be repaired");

    assert_eq!(repaired.0, "pkg/file.py");
    assert_eq!(repaired.1, "read_file");
    assert_eq!(tool_args["path"], "pkg/file.py");
}

#[test]
fn missing_edit_path_not_repaired_when_ambiguous() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(dir.path().join("pkg/a.py"), "x = 1\n").unwrap();
    fs::write(dir.path().join("pkg/b.py"), "x = 1\n").unwrap();

    let mut tool_args = json!({"old": "x = 1", "new": "x = 2"});
    let mut read_paths = HashSet::new();
    read_paths.insert("pkg/a.py".to_string());
    read_paths.insert("pkg/b.py".to_string());
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();

    let repaired = super::repair_edit_path_argument(
        "edit_block",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        None,
        &HashSet::new(),
        None,
    );

    assert!(repaired.is_none());
    assert!(tool_args.get("path").is_none());
}

#[test]
fn missing_edit_path_repaired_from_unique_old_text() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(dir.path().join("pkg/a.py"), "alpha = 1\n").unwrap();
    fs::write(dir.path().join("pkg/b.py"), "target_value = 41\n").unwrap();

    let mut tool_args = json!({"old": "target_value = 41", "new": "target_value = 42"});
    let mut read_paths = HashSet::new();
    read_paths.insert("pkg/a.py".to_string());
    read_paths.insert("pkg/b.py".to_string());
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();

    let repaired = super::repair_edit_path_argument(
        "edit_line",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        None,
        &HashSet::new(),
        None,
    )
    .expect("unique old text should repair missing path");

    assert_eq!(repaired.0, "pkg/b.py");
    assert_eq!(repaired.1, "read_file");
    assert_eq!(tool_args["path"], "pkg/b.py");
}

#[test]
fn edit_path_handle_repaired_to_grounded_candidate() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(dir.path().join("pkg/a.py"), "alpha = 1\n").unwrap();
    fs::write(dir.path().join("pkg/b.py"), "beta = 1\n").unwrap();

    let mut tool_args = json!({"path": "P2", "old": "beta = 1", "new": "beta = 2"});
    let mut read_paths = HashSet::new();
    read_paths.insert("pkg/a.py".to_string());
    read_paths.insert("pkg/b.py".to_string());
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();

    let repaired = super::repair_edit_path_argument(
        "edit_line",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        None,
        &HashSet::new(),
        None,
    )
    .expect("path handle should repair to candidate");

    assert_eq!(repaired.0, "pkg/b.py");
    assert_eq!(repaired.1, "path handle");
    assert_eq!(tool_args["path"], "pkg/b.py");
}

#[test]
fn invalid_edit_path_repaired_from_unique_old_text() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(dir.path().join("pkg/real.py"), "needle = 1\n").unwrap();
    fs::write(dir.path().join("pkg/other.py"), "hay = 1\n").unwrap();

    let mut tool_args =
        json!({"path": "<ipython-input-1>", "old": "needle = 1", "new": "needle = 2"});
    let mut read_paths = HashSet::new();
    read_paths.insert("pkg/real.py".to_string());
    read_paths.insert("pkg/other.py".to_string());
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();

    let repaired = super::repair_edit_path_argument(
        "edit_line",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        None,
        &HashSet::new(),
        None,
    )
    .expect("invalid placeholder path should repair from unique old text");

    assert_eq!(repaired.0, "pkg/real.py");
    assert_eq!(repaired.1, "read_file");
    assert_eq!(tool_args["path"], "pkg/real.py");
}

#[test]
fn missing_edit_path_repaired_from_active_patch_hypothesis() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(dir.path().join("pkg/active.py"), "target = 1\n").unwrap();

    let mut tool_args = json!({"old": "target = 1", "new": "target = 2"});
    let read_paths = HashSet::new();
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    let sw_test_files = HashMap::new();
    let active = super::PatchHypothesis {
        id: 1,
        path: "pkg/active.py".to_string(),
        score: 220,
        reason: "explicit source locus".to_string(),
    };

    let repaired = super::repair_edit_path_argument(
        "edit_block",
        &mut tool_args,
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        &sw_test_files,
        dir.path().to_str().unwrap(),
        Some(&active),
        &HashSet::new(),
        None,
    )
    .expect("active hypothesis should be a grounded repair path");

    assert_eq!(repaired.0, "pkg/active.py");
    assert_eq!(repaired.1, "active hypothesis");
    assert_eq!(tool_args["path"], "pkg/active.py");
}

#[test]
fn source_locus_intel_includes_active_retained_and_problem_shape_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::create_dir_all(dir.path().join("tests")).unwrap();
    fs::write(dir.path().join("pkg/active.py"), "active = True\n").unwrap();
    fs::write(dir.path().join("pkg/retained.py"), "retained = True\n").unwrap();
    fs::write(dir.path().join("pkg/shape.py"), "shape = True\n").unwrap();
    fs::write(dir.path().join("tests/test_shape.py"), "def test(): pass\n").unwrap();

    let sw_test_files = HashMap::from([(
        "tests/test_shape.py".to_string(),
        "tests/test_shape.py".to_string(),
    )]);
    let active = super::PatchHypothesis {
        id: 1,
        path: "pkg/active.py".to_string(),
        score: 240,
        reason: "active locus".to_string(),
    };
    let retained = HashSet::from(["pkg/retained.py".to_string()]);
    let shape = problem_shape_from_scores(
        &[
            ("pkg/shape.py", 100),
            ("tests/test_shape.py", 999),
            ("pkg/active.py", 50),
        ],
        false,
        false,
        Vec::new(),
    );

    let intel = super::collect_source_locus_focus_intel(
        &sw_test_files,
        dir.path().to_str().unwrap(),
        Some(&active),
        &retained,
        Some(&shape),
    );
    let paths: Vec<_> = intel
        .iter()
        .map(|candidate| candidate.path.as_str())
        .collect();
    let sources: Vec<_> = intel.iter().map(|candidate| candidate.source).collect();

    assert_eq!(
        paths,
        vec!["pkg/active.py", "pkg/retained.py", "pkg/shape.py"]
    );
    assert_eq!(
        sources,
        vec!["active hypothesis", "retained candidate", "problem shape"]
    );
    assert!(!paths.contains(&"tests/test_shape.py"));
}

#[test]
fn harness_validation_scope_uses_test_label_as_runnable_scope() {
    let previous = std::env::var("SW_TEST_LABEL").ok();
    unsafe {
        std::env::set_var(
            "SW_TEST_LABEL",
            "backends.sqlite.tests.SchemaTests.test_reserved_table_name",
        );
    }

    let (scope, desc) = super::harness_validation_scope_from_env();
    restore_env("SW_TEST_LABEL", previous);

    assert_eq!(
        scope,
        json!({"label": "backends.sqlite.tests.SchemaTests.test_reserved_table_name"})
    );
    assert_eq!(
        desc,
        "SW_TEST_LABEL=backends.sqlite.tests.SchemaTests.test_reserved_table_name"
    );
}

#[test]
fn explicit_source_path_extraction_finds_paths_embedded_in_urls() {
    let source_files = vec![
        "django/contrib/contenttypes/management/__init__.py",
        "django/db/migrations/operations/models.py",
    ];
    let task = "See https://github.com/django/django/blob/586a9dc/django/contrib/contenttypes/management/__init__.py#L27";

    let selected = super::explicit_source_paths_from_task(task, &source_files);

    assert_eq!(
        selected,
        vec!["django/contrib/contenttypes/management/__init__.py".to_string()]
    );
}

#[test]
fn ranked_locus_excerpts_returns_diverse_anchor_windows() {
    let content = r#"
class SQLCompiler:
    def as_sql(self):
        pass

    def unrelated(self):
        return self.query

    def get_order_by(self):
        if self.query.order_by:
            return self.query.order_by
        return []

class Other:
    def get_order_by(self):
        return []
"#;
    let regions = vec![(9, "order_by".to_string()), (14, "order_by".to_string())];

    let excerpts = ranked_locus_excerpts(content, Some(&regions), "if self.union_order_by:");

    assert!(!excerpts.is_empty());
    assert!(excerpts.len() <= 3);
    assert!(
        excerpts
            .iter()
            .any(|excerpt| excerpt.reason.contains("localized hit"))
    );
}

#[test]
fn inspect_class_locations_extracts_editable_loci() {
    let output = "\
Class hierarchy for Contains:\n\
  Contains @ sympy/sets/contains.py:8\n\
  Boolean @ sympy/logic/boolalg.py:114 - __slots__: MISSING\n";

    let locations = inspect_class_locations(output);

    assert_eq!(locations.len(), 2);
    assert_eq!(locations[0].file, "sympy/sets/contains.py");
    assert_eq!(locations[0].line, 8);
    assert!(!locations[0].missing_attr);
    assert_eq!(locations[1].file, "sympy/logic/boolalg.py");
    assert_eq!(locations[1].line, 114);
    assert!(locations[1].missing_attr);
}

#[test]
fn compact_test_telemetry_preserves_probe_control_signals() {
    let output = "\
SW_TEST_EXIT_CODE=-1\n\
SW_TEST_ENV_UNAVAILABLE=0\n\
SW_TEST_COMMAND=bin/test [\"-C\", \"--verbose\"]\n\
SW_TEST_TIMED_OUT=1\n\
SW_TEST_EARLY_STOPPED=1\n\
SW_TEST_ELAPSED_MS=300030\n\
---\n\
FAIL: test_streamed_failure\n";

    let summary = compact_test_telemetry(output, "bounded unscoped discovery probe", "qwen3:8b");

    assert!(summary.contains("signal: timed out"));
    assert!(summary.contains("signal: early stopped"));
    assert!(summary.contains("elapsed_ms: 300030"));
    assert!(summary.contains("FAIL: test_streamed_failure"));
}

#[test]
fn auto_test_pass_completion_requires_issue_local_test_files() {
    let _guard = SW_TEST_CAN_COMPLETE_ENV_LOCK.lock().unwrap();
    let previous = std::env::var("SW_TEST_CAN_COMPLETE").ok();
    unsafe {
        std::env::remove_var("SW_TEST_CAN_COMPLETE");
    }
    assert!(super::auto_test_pass_can_complete(
        "SW_TEST_FILES=tests/test_contains.py"
    ));
    assert!(super::auto_test_pass_can_complete(
        "SW_TEST_LABEL=backends.sqlite.tests.SchemaTests.test_reserved_table_name"
    ));
    assert!(!super::auto_test_pass_can_complete(
        "adjacent tests directory"
    ));
    restore_env("SW_TEST_CAN_COMPLETE", previous);
}

#[test]
fn auto_test_pass_completion_rejects_feedback_only_scope() {
    let _guard = SW_TEST_CAN_COMPLETE_ENV_LOCK.lock().unwrap();
    let previous = std::env::var("SW_TEST_CAN_COMPLETE").ok();
    unsafe {
        std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
    }

    assert!(!super::auto_test_pass_can_complete(
        "SW_TEST_FILES=tests/test_contains.py"
    ));

    restore_env("SW_TEST_CAN_COMPLETE", previous);
}

#[test]
fn test_scope_can_complete_rejects_feedback_only_marker() {
    let output = "SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\nSW_TEST_SCOPE_TRUSTED=1\nSW_TEST_CAN_COMPLETE=0\n---\n1 passed\n";
    assert!(!super::test_scope_can_complete(output));
}

#[test]
fn restore_tracked_test_side_effects_restores_test_deleted_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("tests/static")).unwrap();
    fs::write(dir.path().join("tests/static/fixture.txt"), "fixture\n").unwrap();

    for args in [
        vec!["init"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test"],
        vec!["add", "."],
        vec!["commit", "-m", "init"],
    ] {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir.path())
            .status()
            .expect("git command");
        assert!(status.success());
    }

    super::tools::snapshot_files(dir.path().to_str().unwrap());
    let before = super::tools::all_diff_stats(dir.path().to_str().unwrap());
    fs::remove_file(dir.path().join("tests/static/fixture.txt")).unwrap();

    let restored = super::restore_tracked_test_side_effects(dir.path().to_str().unwrap(), &before);

    assert_eq!(restored, vec!["tests/static/fixture.txt".to_string()]);
    assert!(dir.path().join("tests/static/fixture.txt").is_file());
    assert!(super::tools::all_diff_stats(dir.path().to_str().unwrap()).is_empty());
}

#[test]
fn issue_behavior_checklist_extracts_repro_code_and_signals() {
    let task = r#"
Adding a vector to zero fails.

```
from sympy.physics.vector import ReferenceFrame
N = ReferenceFrame('N')
N.x + 0
```

This raises TypeError but should return the original vector.
"#;

    let checklist = super::issue_behavior_checklist(task);

    assert!(checklist.contains("N.x + 0"));
    assert!(checklist.contains("TypeError"));
    assert!(checklist.contains("should return the original vector"));
}

#[test]
fn test_env_unavailable_detects_sw_marker_with_prefix() {
    // Verify that the structured SW_TEST_ENV_UNAVAILABLE=1 marker is detected,
    // regardless of what message precedes it.
    let output =
        "TEST_ENV_UNAVAILABLE: some env error\nSW_TEST_EXIT_CODE=1\nSW_TEST_ENV_UNAVAILABLE=1\n";
    assert!(super::test_env_unavailable(output));
}

#[test]
fn test_env_unavailable_detects_sw_marker() {
    let output = "some output\nSW_TEST_ENV_UNAVAILABLE=1\nmore stuff\n";
    assert!(super::test_env_unavailable(output));
}

#[test]
fn test_env_unavailable_rejects_normal_failure() {
    let output = "SW_TEST_EXIT_CODE=1\nSW_TEST_ENV_UNAVAILABLE=0\nFAILED (failures=2)\n";
    assert!(!super::test_env_unavailable(output));
}

#[test]
fn feedback_only_collection_noise_after_source_repair_is_unavailable() {
    let output = "\
SW_TEST_EXIT_CODE=4
SW_TEST_ENV_UNAVAILABLE=0
SW_TEST_CAN_COMPLETE=0
SW_TEST_COMMAND=conda [\"run\", \"pytest\", \"astropy/modeling/tests/test_core.py\"]
---
ERROR collecting astropy/modeling/tests/test_core.py
ImportError: Convolution C extension is missing. Try re-building astropy.
";
    let changed = vec![("astropy/modeling/separable.py".to_string(), 1, 1)];

    assert!(super::feedback_only_collection_failure_should_be_unavailable(output, &changed));
}

#[test]
fn feedback_only_collection_failure_touching_changed_source_stays_blocking() {
    let output = "\
SW_TEST_EXIT_CODE=4
SW_TEST_ENV_UNAVAILABLE=0
SW_TEST_CAN_COMPLETE=0
---
ERROR collecting astropy/modeling/tests/test_separable.py
ImportError: astropy/modeling/separable.py
SyntaxError: invalid syntax
";
    let changed = vec![("astropy/modeling/separable.py".to_string(), 1, 1)];

    assert!(!super::feedback_only_collection_failure_should_be_unavailable(output, &changed));
}

#[test]
fn feedback_only_conftest_import_noise_is_unavailable_without_prior_repair_pass() {
    let output = "\
SW_TEST_EXIT_CODE=4
SW_TEST_ENV_UNAVAILABLE=0
SW_TEST_CAN_COMPLETE=0
SW_TEST_COMMAND=conda [\"run\", \"pytest\", \"lib/matplotlib/tests/test_backend_qt.py\"]
---
ImportError while loading conftest '/testbed/lib/matplotlib/tests/conftest.py'.
E   ImportError: cannot import name '_version' from partially initialized module 'matplotlib'
";
    let changed = vec![(
        "lib/matplotlib/backends/backend_macosx.py".to_string(),
        1,
        1,
    )];

    assert!(super::feedback_only_collection_failure_should_be_unavailable(output, &changed));
}

#[test]
fn scoped_test_file_prefers_pytest_file_over_fixture() {
    let selected = preferred_scoped_test_file(
        "tests/roots/test-toctree/baz.rst:tests/test_builders/test_toctree.py",
    );
    assert_eq!(
        selected.as_deref(),
        Some("tests/test_builders/test_toctree.py")
    );
}

#[test]
fn scoped_test_file_prefers_django_tests_py_over_models_py() {
    let selected = preferred_scoped_test_file("tests/delete/models.py:tests/delete/tests.py");
    assert_eq!(selected.as_deref(), Some("tests/delete/tests.py"));
}

#[test]
fn repo_localization_asset_detects_locale_catalogs() {
    assert!(super::is_repo_localization_asset(
        "django/conf/locale/en/LC_MESSAGES/django.mo"
    ));
    assert!(super::is_repo_localization_asset(
        "pkg/locales/fr/messages.po"
    ));
    assert!(!super::is_repo_localization_asset(
        "django/db/models/query.py"
    ));
}

#[test]
fn task_localization_override_requires_explicit_terms() {
    assert!(super::task_explicitly_mentions_repo_localization(
        "Fix gettext translation extraction for locale catalogs"
    ));
    assert!(!super::task_explicitly_mentions_repo_localization(
        "Optimize QuerySet delete field loading"
    ));
}

#[test]
fn scoped_test_file_falls_back_to_fixture_when_no_python_test_exists() {
    let selected = preferred_scoped_test_file("tests/roots/test-linkcheck/links.txt:doc/usage.rst");
    assert_eq!(
        selected.as_deref(),
        Some("tests/roots/test-linkcheck/links.txt")
    );
}

#[test]
fn test_is_runner_error_rejects_python_exception_line() {
    let output = "SW_TEST_EXIT_CODE=1\nSW_TEST_ENV_UNAVAILABLE=0\n---\nE   NameError: name 'BaseCrossValidator' is not defined\n";
    assert!(!super::test_is_runner_error(output));
}

#[test]
fn parse_response_handles_args_as_json_string() {
    // OpenAI function_call format: args is a JSON string, not an object.
    // The args-as-string decoder should unwrap this before tool dispatch.
    let raw = r#"{"tool_calls": [{"name": "edit_line", "args": "{\"path\": \"foo.py\", \"old\": \"x\", \"new\": \"y\"}"}], "transition": "DONE"}"#;
    let result = parse_response(raw);
    assert!(result.is_some(), "should parse args-as-string format");
    let r = result.unwrap();
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "edit_line");
    // The args may still be a string at parse time — the decoder runs
    // in main.rs before tool dispatch, not in parse_response itself.
    // Just verify the tool call was extracted.
}

#[test]
fn parse_response_handles_transition_as_name_object() {
    // qwen3:8b produces {"name": "DONE"} for transition instead of "DONE"
    let raw = r#"{"tool_calls": [{"name": "edit_line", "args": {"path": "sympy/core/function.py", "old": "x", "new": "y"}}], "transition": {"name": "DONE"}}"#;
    let result = parse_response(raw);
    assert!(
        result.is_some(),
        "should parse transition as {{name}} object"
    );
    let r = result.unwrap();
    assert_eq!(r.transition, Some("DONE".into()));
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "edit_line");
}

#[test]
fn parse_response_handles_transition_name_object_with_trailing_bracket() {
    // qwen3:8b also appends trailing ] making raw string invalid JSON
    let raw = r#"{"tool_calls": [{"name": "edit_line", "args": {"path": "foo.py", "old": "a", "new": "b"}}], "transition": {"name": "DONE"}}]"#;
    let result = parse_response(raw);
    assert!(result.is_some(), "should recover from trailing ]");
    let r = result.unwrap();
    assert_eq!(r.transition, Some("DONE".into()));
}

#[test]
fn parse_response_handles_native_function_call_array() {
    let raw = r#"[{"id":"call_9z3q4w5r","type":"function","function":{"name":"transition","arguments":"{\"event\":\"DONE\"}"}}]"#;
    let result = parse_response(raw);
    assert!(result.is_some(), "should parse native function call arrays");
    let r = result.unwrap();
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "transition");
    assert_eq!(calls[0].args["event"], "DONE");
}

#[test]
fn parse_response_handles_native_function_call_array_with_edit() {
    let raw = r#"[{"id":"call_1","type":"function","function":{"name":"edit_line","arguments":"{\"path\":\"sklearn/feature_selection/_sequential.py\",\"line\":186,\"new\":\"self.cv = cv\"}"}}]"#;
    let result = parse_response(raw);
    assert!(
        result.is_some(),
        "should parse native edit function call arrays"
    );
    let r = result.unwrap();
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "edit_line");
    assert_eq!(
        calls[0].args["path"],
        "sklearn/feature_selection/_sequential.py"
    );
}

#[test]
fn parse_response_preserves_single_tool_object_with_transition() {
    let raw = r#"{"name":"edit_line","args":{"path":"sympy/polys/rings.py","old":"return self.as.expr()","new":"return self.as_expr()"},"transition":"DONE"}"#;
    let result = parse_response(raw);
    assert!(result.is_some(), "should parse single tool object");
    let r = result.unwrap();
    assert_eq!(r.transition.as_deref(), Some("DONE"));
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "edit_line");
    assert_eq!(calls[0].args["path"], "sympy/polys/rings.py");
}

#[test]
fn parse_response_accepts_arguments_key_inside_tool_calls() {
    let raw = r#"{"tool_calls":[{"name":"edit_block","arguments":{"path":"sklearn/preprocessing/_discretization.py","old":"KMeans()","new":"KMeans(random_state=0)"}}]}"#;
    let result = parse_response(raw);
    assert!(result.is_some(), "should parse arguments alias");
    let r = result.unwrap();
    let calls = r.tool_calls.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "edit_block");
    assert_eq!(
        calls[0].args["path"],
        "sklearn/preprocessing/_discretization.py"
    );
}

#[test]
fn collection_scope_failure_is_unrelated_when_diff_file_absent() {
    let output = "SW_TEST_EXIT_CODE=4\n---\nModuleNotFoundError: No module named 'sklearn.__check_build._check_build'\n";
    let changed = vec![(
        "sklearn/preprocessing/_discretization.py".to_string(),
        4usize,
        100usize,
    )];
    assert!(test_collection_failure_unrelated_to_diff(output, &changed));
}

#[test]
fn django_file_label_runtime_error_is_scope_failure() {
    let output = "SW_TEST_EXIT_CODE=1\n---\nTraceback (most recent call last):\nRuntimeError: One of the test labels is a path to a file: 'tests/model_fields/test_imagefield.py', which is not supported. Use a dotted module name or path to a directory instead.\n";
    let changed = vec![("django/db/models/fields/files.py".to_string(), 2, 200)];
    assert!(test_collection_or_scope_failure(output));
    assert!(test_collection_failure_unrelated_to_diff(output, &changed));
}

#[test]
fn astropy_conftest_logging_error_is_invalid_scope_feedback() {
    let output = "SW_TEST_EXIT_CODE=4\n---\nImportError while loading conftest '/testbed/conftest.py'.\nE   astropy.logger.LoggingError: Cannot disable warnings logging: warnings.showwarning was not set by this logger, or has been overridden\n";
    let changed = vec![("astropy/modeling/separable.py".to_string(), 4, 400)];

    assert!(test_collection_or_scope_failure(output));
    assert!(test_collection_failure_unrelated_to_diff(output, &changed));
}

#[test]
fn collection_scope_failure_is_related_when_diff_file_appears() {
    let output = "SW_TEST_EXIT_CODE=4\n---\nFile \"sklearn/preprocessing/_discretization.py\", line 42\nModuleNotFoundError: bad import\n";
    let changed = vec![(
        "sklearn/preprocessing/_discretization.py".to_string(),
        4usize,
        100usize,
    )];
    assert!(!test_collection_failure_unrelated_to_diff(output, &changed));
}

#[test]
fn failure_excerpt_includes_python_exception_lines() {
    let output = "SW_TEST_EXIT_CODE=1\n---\nE   NameError: name 'BaseCrossValidator' is not defined\n============================== 1 failed in 0.28s ===============================";
    let excerpt = super::failure_excerpt(output, 5);
    assert!(excerpt.contains("NameError"));
    assert!(excerpt.contains("1 failed"));
}

#[test]
fn test_is_runner_error_with_translation_oserror() {
    // Django translation OSError contains "Traceback" — test_is_runner_error
    // returns false (it has Python execution evidence). This is correct: the
    // env_miss check in tools.rs catches this BEFORE test_is_runner_error.
    let output = "Traceback (most recent call last):\n  File \"django/utils/translation/trans_real.py\"\nOSError: No translation files found for default language en-us.\nSW_TEST_EXIT_CODE=1\n";
    assert!(
        !super::test_is_runner_error(output),
        "Traceback makes this look like real content, not runner error"
    );
}

#[test]
fn auto_test_failure_signature_is_stable_for_same_failure() {
    let scope = json!({"path": "tests/test_widget.py"});
    let a = "SW_TEST_EXIT_CODE=1\nFAILED tests/test_widget.py::test_value\nE   AssertionError: 1 != 2\n";
    let b = "noise before\nSW_TEST_EXIT_CODE=1\nFAILED tests/test_widget.py::test_value\nE   AssertionError: 1 != 2\nnoise after\n";

    assert_eq!(
        auto_test_failure_signature(&scope, a),
        auto_test_failure_signature(&scope, b)
    );
}

#[test]
fn stagnation_diagnostic_tools_are_non_editing_inspection_tools() {
    assert!(is_stagnation_diagnostic_tool("read_file"));
    assert!(is_stagnation_diagnostic_tool("grep"));
    assert!(is_stagnation_diagnostic_tool("inspect_class"));
    assert!(is_stagnation_diagnostic_tool("run_test"));
    assert!(super::is_same_test_recovery_tool("read_file"));
    assert!(!super::is_same_test_recovery_tool("run_test"));
    assert!(!super::is_same_test_recovery_tool("list_directory"));
    assert!(super::is_fresh_recovery_observation("fresh content", false));
    assert!(!super::is_fresh_recovery_observation("fresh content", true));
    assert!(!super::is_fresh_recovery_observation(
        "(cached — prior)",
        false
    ));
    assert!(!is_stagnation_diagnostic_tool("edit_line"));
    assert!(!is_stagnation_diagnostic_tool("write_file"));
}

#[test]
fn patch_shape_violation_rejects_wide_or_oversized_patches() {
    let wide: Vec<(String, usize, usize)> = (0..13)
        .map(|idx| (format!("pkg/file_{}.py", idx), 1, 10))
        .collect();
    assert!(
        super::patch_shape_violation(&wide, 5)
            .unwrap()
            .contains("wide patch")
    );

    let oversized = vec![("pkg/file.py".to_string(), 6, 10)];
    assert!(
        super::patch_shape_violation(&oversized, 5)
            .unwrap()
            .contains("oversized edit")
    );

    let focused = vec![("pkg/file.py".to_string(), 2, 10)];
    assert!(super::patch_shape_violation(&focused, 5).is_none());
}

#[test]
fn problem_shape_boosts_explicit_source_paths() {
    let ranked = vec![
        ("pkg/noisy.py".to_string(), 80usize),
        ("pkg/fix.py".to_string(), 10usize),
    ];
    let explicit = vec!["pkg/fix.py".to_string()];
    let mut regions = HashMap::new();
    regions.insert(
        "pkg/fix.py".to_string(),
        vec![(12usize, "target".to_string())],
    );
    let contexts = HashMap::new();

    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        true,
        &["tests/test_fix.py".to_string()],
        &[],
        &[],
        false,
        8,
    );

    assert_eq!(shape.top_files[0].path, "pkg/fix.py");
    assert!(
        shape.top_files[0]
            .reasons
            .iter()
            .any(|reason| reason.contains("explicit issue path"))
    );
    assert!(
        shape
            .render_file_ranking_section()
            .contains("## Problem Shape")
    );
}

#[test]
fn problem_shape_dedupes_and_filters_non_source_hypotheses() {
    let ranked = vec![
        ("./pkg/fix.py".to_string(), 10usize),
        ("pkg/fix.py".to_string(), 20usize),
        ("./release/build_docs.py".to_string(), 90usize),
        ("./doc/generate.py".to_string(), 80usize),
        ("./.ci/parse_durations.py".to_string(), 70usize),
        ("./bin/coverage_doctest.py".to_string(), 60usize),
        ("setup.py".to_string(), 50usize),
        ("pkg/tests/test_fix.py".to_string(), 40usize),
        ("pkg/other.py".to_string(), 5usize),
    ];
    let explicit = vec!["./pkg/fix.py".to_string()];
    let regions = HashMap::new();
    let contexts = HashMap::new();

    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        false,
        &[],
        &[],
        &[],
        true,
        8,
    );

    let paths: Vec<_> = shape
        .top_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(paths, vec!["pkg/fix.py", "pkg/other.py"]);
    assert_eq!(shape.top_files[0].score, 220);

    let hypotheses = shape.hypotheses();
    assert_eq!(hypotheses.len(), 2);
    assert_eq!(hypotheses[0].id, 1);
    assert_eq!(hypotheses[0].path, "pkg/fix.py");
    assert_eq!(hypotheses[1].id, 2);
    assert_eq!(hypotheses[1].path, "pkg/other.py");
}

fn problem_shape_from_scores(
    scores: &[(&str, usize)],
    trusted_test_scope: bool,
    feedback_scope_promoted: bool,
    advisory_test_candidates: Vec<super::SourceTestCandidate>,
) -> super::ProblemShape {
    let ranked: Vec<(String, usize)> = scores
        .iter()
        .map(|(path, score)| ((*path).to_string(), *score))
        .collect();
    let regions = HashMap::new();
    let contexts = HashMap::new();
    super::ProblemShape::from_ranked_files(
        &ranked,
        &[],
        &regions,
        &contexts,
        trusted_test_scope,
        &[],
        &[],
        &advisory_test_candidates,
        feedback_scope_promoted,
        8,
    )
}

fn scout_route_settings() -> super::ScoutRouteSettings {
    super::ScoutRouteSettings {
        lane_escalation_enabled: false,
        max_top_files: 2,
        min_ratio_percent: 250,
        max_hypotheses: 2,
        cheap_hypothesis_limit: 1,
        probe_child_timeout_seconds: 300,
        promoted_min_ratio_percent: 250,
        promoted_min_top_score: 20,
        promoted_hypothesis_limit: 2,
        progressive_hypothesis_limit: 3,
        progressive_fanout_max_candidates: 3,
        progressive_fanout_concurrency: 1,
        progressive_child_max_steps: 30,
        progressive_child_timeout_seconds: 600,
        full_hypothesis_limit: 7,
        full_fanout_max_candidates: 7,
        full_fanout_concurrency: 2,
        full_child_max_steps: 45,
        full_child_timeout_seconds: 600,
        route_fanout_wall_seconds: 1200,
        route_fanout_timeout_stop_count: 2,
    }
}

#[test]
fn full_fanout_route_still_contributes_all_three_tournament_stages() {
    let mut settings = scout_route_settings();
    settings.lane_escalation_enabled = true;

    let lanes = super::ScoutRouteDecision::build_escalation_lanes(true, "full_fanout", 7, settings);
    let names: Vec<_> = lanes.iter().map(|lane| lane.name.as_str()).collect();

    assert_eq!(
        names,
        vec!["focused_probe", "progressive_fanout", "full_fanout"]
    );
}

#[test]
fn clu_policy_keeps_focused_trusted_locus_conservative() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 200), ("pkg/nearby.py", 80)],
        true,
        false,
        Vec::new(),
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 120, 2);

    assert_eq!(policy.profile, "focused_validated_locus");
    assert_eq!(policy.workflow_lane, super::CluWorkflowLane::Retention);
    assert_eq!(policy.candidate_bank_max, 4);
    assert!(!policy.candidate_bank_reanchor);
    assert!(!policy.candidate_bank_early_stop);
    assert!(policy.patch_tournament_enabled);
    assert_eq!(policy.path_argument_failure_threshold, 2);
    assert_eq!(policy.scope_validation_max_candidates, 4);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 0);
}

#[test]
fn clu_policy_repairs_dominant_promoted_source_scope_before_trusting_it() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 220), ("pkg/nearby.py", 100)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 8);

    assert_eq!(policy.profile, "promoted_dominant_source_locus");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::AgentlessScopeFirst
    );
    assert_eq!(policy.candidate_bank_max, 6);
    assert!(policy.candidate_bank_reanchor);
    assert!(!policy.candidate_bank_early_stop);
    assert_eq!(policy.path_argument_failure_threshold, 2);
    assert_eq!(policy.scope_validation_total_seconds, 300);
    assert_eq!(policy.scope_validation_max_candidates, 6);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 1);
    assert!(
        policy
            .reasons
            .iter()
            .any(|reason| reason.contains("not authoritative"))
    );
}

#[test]
fn scout_router_downshifts_focused_trusted_locus_to_no_fanout() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 260), ("pkg/nearby.py", 100)],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 120, 2);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "cheap_no_fanout");
    assert!(decision.skip_fanout());
    assert!(!decision.fanout_enabled);
    assert_eq!(decision.original_hypothesis_count, 2);
    assert_eq!(decision.retained_hypothesis_count, 1);
    assert!(
        decision
            .official_verifier_boundary
            .contains("current-instance localization shape only")
    );
}

#[test]
fn scout_router_escalates_dominant_promoted_source_policy_by_default() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 220), ("pkg/nearby.py", 100)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 8);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "progressive_fanout");
    assert!(!decision.skip_fanout());
    assert!(decision.fanout_enabled);
    assert_eq!(decision.retained_hypothesis_count, 2);
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("promoted scope has dominant"))
    );
}

#[test]
fn scout_router_uses_progressive_fanout_for_ambiguous_shape() {
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 100),
            ("pkg/b.py", 95),
            ("pkg/c.py", 90),
            ("pkg/d.py", 85),
        ],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 500, 4);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "progressive_fanout");
    assert!(!decision.skip_fanout());
    assert!(decision.progressive_fanout());
    assert!(decision.fanout_enabled);
    assert_eq!(decision.retained_hypothesis_count, 3);
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("ambiguous_multi_locus"))
    );
}

#[test]
fn scout_router_disables_fanout_inside_candidate_child_depth() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::set_var("SW_CANDIDATE_FANOUT_DEPTH", "1");
        std::env::set_var("SW_CANDIDATE_FANOUT", "1");
        std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "fanout");
        std::env::set_var("SW_SCOUT_LANE_ESCALATION", "1");
    }
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 100),
            ("pkg/b.py", 95),
            ("pkg/c.py", 90),
            ("pkg/d.py", 85),
        ],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 500, 4);
    let decision = super::ScoutRouteDecision::from_env(Some(&policy), shape.hypotheses().len());

    assert_eq!(decision.route, "fanout_child_no_fanout");
    assert!(!decision.fanout_enabled);
    assert!(!decision.lane_escalation_enabled);
    assert!(decision.escalation_lanes.is_empty());
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("child depth 1"))
    );

    decision.apply_runtime_env();
    assert_eq!(std::env::var("SW_CANDIDATE_FANOUT").as_deref(), Ok("0"));
    assert_eq!(std::env::var("SW_SCOUT_FANOUT").as_deref(), Ok("0"));
    assert_eq!(
        std::env::var("SW_SCOUT_LANE_ESCALATION").as_deref(),
        Ok("0")
    );

    unsafe {
        std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
        std::env::remove_var("SW_CANDIDATE_FANOUT");
        std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
        std::env::remove_var("SW_SCOUT_LANE_ESCALATION");
        std::env::remove_var("SW_SCOUT_FANOUT");
    }
}

#[test]
fn scout_router_escalates_promoted_dominant_locus_by_default() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::remove_var("SW_SCOUT_PROMOTED_DOMINANT_FANOUT");
        std::env::remove_var("DEPRECATED_SW_PROMOTED_DOMINANT_NO_FANOUT");
    }
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 300), ("pkg/nearby.py", 20)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "progressive_fanout");
    assert!(!decision.skip_fanout());
    assert!(decision.fanout_enabled);
    assert_eq!(decision.retained_hypothesis_count, 2);
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("promoted scope has dominant"))
    );
    assert!(decision.reasons.iter().any(|reason| {
        reason.contains("promoted-dominant untrusted scope routes")
            || reason.contains("progressive fanout keeps")
    }));
}

#[test]
fn deprecated_promoted_dominant_no_fanout_preserves_old_route() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::remove_var("SW_SCOUT_PROMOTED_DOMINANT_FANOUT");
        std::env::set_var("DEPRECATED_SW_PROMOTED_DOMINANT_NO_FANOUT", "1");
    }
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 300), ("pkg/nearby.py", 20)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "promoted_dominant_no_fanout");
    assert!(decision.skip_fanout());
    assert!(!decision.fanout_enabled);
    assert_eq!(decision.retained_hypothesis_count, 2);

    unsafe {
        std::env::remove_var("DEPRECATED_SW_PROMOTED_DOMINANT_NO_FANOUT");
    }
}

#[test]
fn scout_router_builds_escalation_ladder_for_promoted_probe() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::remove_var("SW_SCOUT_PROMOTED_DOMINANT_FANOUT");
    }
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 300), ("pkg/nearby.py", 20)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let hypotheses = shape.hypotheses();
    let mut settings = scout_route_settings();
    settings.lane_escalation_enabled = true;

    let decision =
        super::ScoutRouteDecision::from_inputs(true, Some(&policy), hypotheses.len(), settings);

    assert_eq!(decision.route, "progressive_fanout");
    assert!(decision.escalation_enabled());
    let lane_names: Vec<_> = decision
        .escalation_lanes
        .iter()
        .map(|lane| lane.name.as_str())
        .collect();
    assert_eq!(
        lane_names,
        vec!["focused_probe", "progressive_fanout", "full_fanout"]
    );
    assert_eq!(decision.escalation_lanes[0].max_candidates, 1);
    assert_eq!(decision.escalation_lanes[1].max_candidates, 3);
    assert_eq!(decision.escalation_lanes[2].max_candidates, 7);
    assert_eq!(decision.escalation_lanes[2].concurrency, 2);
}

#[test]
fn scout_router_progressive_route_still_starts_with_focused_probe() {
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 100),
            ("pkg/b.py", 95),
            ("pkg/c.py", 90),
            ("pkg/d.py", 85),
        ],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 500, 4);
    let hypotheses = shape.hypotheses();
    let mut settings = scout_route_settings();
    settings.lane_escalation_enabled = true;

    let decision =
        super::ScoutRouteDecision::from_inputs(true, Some(&policy), hypotheses.len(), settings);

    assert_eq!(decision.route, "progressive_fanout");
    let lane_names: Vec<_> = decision
        .escalation_lanes
        .iter()
        .map(|lane| lane.name.as_str())
        .collect();
    assert_eq!(
        lane_names,
        vec!["focused_probe", "progressive_fanout", "full_fanout"]
    );
    assert_eq!(decision.escalation_lanes[0].max_candidates, 1);
}

#[test]
fn scout_router_keeps_weak_promoted_scope_on_progressive_fanout() {
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 40),
            ("pkg/b.py", 35),
            ("pkg/c.py", 34),
            ("pkg/d.py", 33),
        ],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_a.py".to_string(),
            score: 20,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_inputs(
        true,
        Some(&policy),
        hypotheses.len(),
        scout_route_settings(),
    );

    assert_eq!(decision.route, "progressive_fanout");
    assert!(!decision.skip_fanout());
    assert!(decision.progressive_fanout());
    assert!(decision.fanout_enabled);
    assert_eq!(decision.retained_hypothesis_count, 3);
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("below promoted-dominant min"))
    );
}

#[test]
fn scout_router_honors_candidate_fanout_mode_off() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::set_var("SW_SCOUT_ROUTER", "1");
        std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "off");
    }
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 40),
            ("pkg/b.py", 35),
            ("pkg/c.py", 34),
            ("pkg/d.py", 33),
        ],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_a.py".to_string(),
            score: 20,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let hypotheses = shape.hypotheses();

    let decision = super::ScoutRouteDecision::from_env(Some(&policy), hypotheses.len());

    assert_eq!(decision.route, "fanout_feature_disabled");
    assert!(!decision.fanout_enabled);
    assert!(decision.skip_fanout());
    assert!(!decision.escalation_enabled());
    assert!(decision.escalation_lanes.is_empty());
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| reason.contains("feature flag disabled"))
    );

    unsafe {
        std::env::remove_var("SW_SCOUT_ROUTER");
        std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
    }
}

#[test]
fn clu_policy_routes_weak_promoted_feedback_scope_to_exploration() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 80), ("pkg/nearby.py", 70)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);

    assert_eq!(policy.profile, "promoted_scope_exploration");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::ReanchorTournament
    );
    assert_eq!(policy.candidate_bank_max, 8);
    assert!(policy.candidate_bank_reanchor);
    assert!(!policy.candidate_bank_early_stop);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 2);
    assert_eq!(policy.scope_validation_total_seconds, 300);
    assert_eq!(policy.scope_validation_max_candidates, 8);
}

#[test]
fn clu_policy_expands_for_ambiguous_multi_locus_shape() {
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 100),
            ("pkg/b.py", 90),
            ("pkg/c.py", 85),
            ("pkg/d.py", 80),
        ],
        true,
        false,
        Vec::new(),
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 500, 4);

    assert_eq!(policy.profile, "ambiguous_multi_locus");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::ReanchorTournament
    );
    assert_eq!(policy.candidate_bank_max, 8);
    assert!(policy.candidate_bank_reanchor);
    assert!(!policy.candidate_bank_early_stop);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 2);
    assert_eq!(policy.scope_validation_total_seconds, 360);
    assert_eq!(policy.scope_validation_max_candidates, 8);
}

#[test]
fn clu_policy_expands_when_scope_is_only_advisory() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 200)],
        false,
        false,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 75, 1);

    assert_eq!(policy.profile, "weak_scope_exploration");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::AgentlessScopeFirst
    );
    assert_eq!(policy.candidate_bank_max, 6);
    assert!(policy.candidate_bank_reanchor);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 2);
    assert_eq!(policy.scope_validation_max_candidates, 6);
    assert_eq!(policy.metrics.advisory_test_candidate_count, 1);
}

#[test]
fn aggressive_clu_routes_weak_scope_broad_shape_to_tournament() {
    let shape = problem_shape_from_scores(
        &[
            ("pkg/a.py", 110),
            ("pkg/b.py", 95),
            ("pkg/c.py", 70),
            ("pkg/d.py", 65),
        ],
        false,
        false,
        vec![
            super::SourceTestCandidate {
                path: "tests/test_a.py".to_string(),
                score: 80,
                reason: "source adjacent".to_string(),
                trust_tier: "edited_source_adjacent".to_string(),
            },
            super::SourceTestCandidate {
                path: "tests/test_b.py".to_string(),
                score: 72,
                reason: "source adjacent".to_string(),
                trust_tier: "edited_source_adjacent".to_string(),
            },
        ],
    );

    let policy =
        super::CluSolverPolicy::from_problem_shape_with_options(&shape, 500, 6, true, true);

    assert_eq!(policy.profile, "ambiguous_multi_locus");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::ReanchorTournament
    );
    assert_eq!(policy.candidate_bank_max, 8);
    assert!(policy.candidate_bank_reanchor);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 1);
    assert_eq!(policy.scope_validation_total_seconds, 360);
    assert_eq!(policy.scope_validation_max_candidates, 8);
    assert_eq!(policy.path_argument_failure_threshold, 3);
    assert!(
        policy
            .reasons
            .iter()
            .any(|reason| reason.contains("aggressive CLU calibration"))
    );
}

#[test]
fn aggressive_clu_preserves_dominant_untrusted_source_lane() {
    let ranked = vec![
        ("pkg/fix.py".to_string(), 240),
        ("pkg/noise.py".to_string(), 50),
    ];
    let explicit = vec!["pkg/fix.py".to_string()];
    let regions = HashMap::new();
    let contexts = HashMap::new();
    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        false,
        &[],
        &[],
        &[],
        false,
        8,
    );

    let policy = super::CluSolverPolicy::from_problem_shape_with_options(&shape, 75, 2, true, true);

    assert_eq!(policy.profile, "weak_scope_exploration");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::AgentlessScopeFirst
    );
    assert_eq!(policy.candidate_bank_max, 6);
    assert_eq!(policy.candidate_bank_reanchor_quarantine_after, 2);
}

#[test]
fn clu_policy_routes_explicit_untrusted_source_to_scope_first_workflow() {
    let ranked = vec![
        ("pkg/fix.py".to_string(), 10),
        ("pkg/noise.py".to_string(), 70),
    ];
    let explicit = vec!["pkg/fix.py".to_string()];
    let regions = HashMap::new();
    let contexts = HashMap::new();
    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        false,
        &[],
        &[],
        &[],
        false,
        8,
    );

    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 75, 2);

    assert_eq!(policy.profile, "weak_scope_exploration");
    assert_eq!(
        policy.workflow_lane,
        super::CluWorkflowLane::AgentlessScopeFirst
    );
    assert_eq!(policy.candidate_bank_max, 6);
    assert!(policy.candidate_bank_reanchor);
    assert_eq!(policy.scope_validation_max_candidates, 6);
}

#[test]
fn clu_policy_scalar_fallback_preserves_untrusted_source_behavior() {
    let ranked = vec![
        ("pkg/fix.py".to_string(), 10),
        ("pkg/noise.py".to_string(), 70),
    ];
    let explicit = vec!["pkg/fix.py".to_string()];
    let regions = HashMap::new();
    let contexts = HashMap::new();
    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        false,
        &[],
        &[],
        &[],
        false,
        8,
    );

    let policy = super::CluSolverPolicy::from_problem_shape_with_workflow(&shape, 75, 2, false);

    assert_eq!(policy.profile, "focused_source_untrusted_scope");
    assert_eq!(policy.workflow_lane, super::CluWorkflowLane::Retention);
    assert_eq!(policy.candidate_bank_max, 1);
    assert!(!policy.candidate_bank_reanchor);
    assert!(
        policy
            .reasons
            .iter()
            .any(|reason| reason.contains("SW_CLU_WORKFLOW disabled"))
    );
}

#[test]
fn workflow_lane_controls_stagnation_and_path_switching() {
    let retention = super::CluSolverPolicy {
        profile: "focused_validated_locus".to_string(),
        workflow_lane: super::CluWorkflowLane::Retention,
        candidate_bank_enabled: true,
        candidate_bank_max: 4,
        candidate_bank_reanchor: false,
        candidate_bank_early_stop: false,
        candidate_bank_early_stop_min_score: 60,
        candidate_bank_early_stop_fail_count: 6,
        candidate_bank_reanchor_quarantine_after: 0,
        patch_tournament_enabled: true,
        off_hypothesis_edit_threshold: 2,
        path_argument_failure_threshold: 2,
        hypothesis_step_budget: 0,
        scope_validation_timeout_seconds: 90,
        scope_validation_total_seconds: 180,
        scope_validation_max_candidates: 4,
        scope_validation_groups_last: true,
        metrics: super::CluShapeMetrics::default(),
        reasons: Vec::new(),
    };
    let tournament = super::CluSolverPolicy {
        workflow_lane: super::CluWorkflowLane::ReanchorTournament,
        candidate_bank_reanchor: true,
        candidate_bank_max: 6,
        profile: "ambiguous_multi_locus".to_string(),
        ..retention.clone()
    };

    assert!(!super::path_argument_failures_should_switch_hypothesis(
        Some(&retention)
    ));
    assert!(super::path_argument_failures_should_switch_hypothesis(
        Some(&tournament)
    ));
    assert_eq!(
        super::no_progress_hypothesis_threshold(Some(&retention), 4),
        5
    );
    assert_eq!(
        super::no_progress_hypothesis_threshold(Some(&tournament), 4),
        2
    );
}

#[test]
fn candidate_scope_timeout_is_calibrated_from_measured_baseline_runtime() {
    assert_eq!(super::calibrated_scope_timeout_seconds(90, None), 90);
    assert_eq!(
        super::calibrated_scope_timeout_seconds(90, Some(83_000)),
        145
    );
    assert_eq!(
        super::calibrated_scope_timeout_seconds(90, Some(600_000)),
        600
    );
}

#[test]
fn reanchor_quarantine_only_marks_retained_candidate_paths_after_threshold() {
    let retained = HashSet::from(["pkg/a.py".to_string()]);
    let mut counts = HashMap::new();
    let mut quarantined = HashSet::new();
    let changed = vec!["pkg/a.py".to_string(), "pkg/b.py".to_string()];

    let first = super::update_reanchor_quarantine_for_paths(
        &mut counts,
        &mut quarantined,
        &changed,
        &retained,
        2,
    );
    assert!(first.is_empty());
    assert!(!quarantined.contains("pkg/a.py"));
    assert!(!counts.contains_key("pkg/b.py"));

    let second = super::update_reanchor_quarantine_for_paths(
        &mut counts,
        &mut quarantined,
        &changed,
        &retained,
        2,
    );
    assert_eq!(second, vec!["pkg/a.py".to_string()]);
    assert!(quarantined.contains("pkg/a.py"));

    let third = super::update_reanchor_quarantine_for_paths(
        &mut counts,
        &mut quarantined,
        &changed,
        &retained,
        2,
    );
    assert!(third.is_empty());
}

#[test]
fn patch_hypothesis_advances_after_stagnation() {
    let _guard = ARTIFACT_ENV_LOCK.lock().unwrap();
    let previous = std::env::var("SW_ARTIFACT_DIR").ok();
    unsafe {
        std::env::remove_var("SW_ARTIFACT_DIR");
    }
    let hypotheses = vec![
        super::PatchHypothesis {
            id: 1,
            path: "pkg/a.py".to_string(),
            score: 10,
            reason: "first".to_string(),
        },
        super::PatchHypothesis {
            id: 2,
            path: "pkg/b.py".to_string(),
            score: 9,
            reason: "second".to_string(),
        },
    ];
    let mut active = 0usize;

    let prompt = super::advance_patch_hypothesis(
        &hypotheses,
        &mut active,
        "same_test_signature",
        "same assertion failed twice",
    )
    .expect("second hypothesis should be available");

    assert_eq!(active, 1);
    assert!(prompt.contains("Patch hypothesis 2/2"));
    assert!(prompt.contains("pkg/b.py"));
    restore_env("SW_ARTIFACT_DIR", previous);
}

#[test]
fn causal_failover_advances_to_the_next_ranked_hypothesis() {
    let hypotheses = vec![
        super::PatchHypothesis {
            id: 1,
            path: "pkg/first.py".to_string(),
            score: 100,
            reason: "top locus".to_string(),
        },
        super::PatchHypothesis {
            id: 2,
            path: "pkg/second.py".to_string(),
            score: 90,
            reason: "alternate locus".to_string(),
        },
    ];
    let mut active = 0usize;

    let prompt = super::advance_causal_failover_hypothesis(
        true,
        &hypotheses,
        &mut active,
        false,
        "model emitted FAIL before patching",
    )
    .expect("causal mode should advance rather than terminally fail");

    assert_eq!(active, 1);
    assert!(prompt.contains("pkg/second.py"));
    assert!(super::advance_causal_failover_hypothesis(
        false,
        &hypotheses,
        &mut active,
        false,
        "non-causal mode keeps its existing failure policy",
    )
    .is_none());
}

#[test]
fn causal_serial_env_keeps_local_candidate_selection_but_disables_fanout() {
    let _guard = CAUSAL_SERIAL_ENV_LOCK.lock().unwrap();
    let keys = [
        "SW_CANDIDATE_FANOUT_DISABLED",
        "SW_CANDIDATE_FANOUT",
        "SW_SCOUT_LANE_ESCALATION",
        "SW_CANDIDATE_BANK",
        "SW_PATCH_TOURNAMENT",
    ];
    let previous: Vec<_> = keys
        .iter()
        .map(|key| (*key, std::env::var(key).ok()))
        .collect();
    unsafe {
        std::env::set_var("SW_CANDIDATE_BANK", "1");
        std::env::set_var("SW_PATCH_TOURNAMENT", "best_of_n");
    }

    enforce_causal_serial_env();

    assert_eq!(std::env::var("SW_CANDIDATE_FANOUT_DISABLED").ok().as_deref(), Some("1"));
    assert_eq!(std::env::var("SW_CANDIDATE_FANOUT").ok().as_deref(), Some("0"));
    assert_eq!(std::env::var("SW_SCOUT_LANE_ESCALATION").ok().as_deref(), Some("0"));
    assert_eq!(std::env::var("SW_CANDIDATE_BANK").ok().as_deref(), Some("1"));
    assert_eq!(std::env::var("SW_PATCH_TOURNAMENT").ok().as_deref(), Some("best_of_n"));

    for (key, value) in previous {
        restore_env(key, value);
    }
}

#[test]
fn clu_artifacts_capture_plan_and_candidate_lifecycle() {
    let _guard = ARTIFACT_ENV_LOCK.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let previous = std::env::var("SW_ARTIFACT_DIR").ok();
    unsafe {
        std::env::set_var("SW_ARTIFACT_DIR", dir.path());
    }
    let shape = problem_shape_from_scores(
        &[("pkg/a.py", 100), ("pkg/b.py", 90)],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 120, 2);
    let hypotheses = shape.hypotheses();

    super::write_repair_evidence_graph_artifact(&shape, Some(&policy), &hypotheses);
    super::write_clu_plan_artifact(&policy, &hypotheses);
    super::write_candidate_state_artifacts(&hypotheses, 0, false, "test selection");
    super::log_patch_attempt(&hypotheses[0], "selected", "unit test");

    restore_env("SW_ARTIFACT_DIR", previous);

    let graph: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("evidence-graph.json")).unwrap(),
    )
    .unwrap();
    let plan: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("clu-plan.json")).unwrap())
            .unwrap();
    let ledger: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("hypothesis-ledger.json")).unwrap(),
    )
    .unwrap();
    let candidates = std::fs::read_to_string(dir.path().join("patch-candidates.jsonl")).unwrap();

    assert_eq!(graph["artifact"], "statewright.repair_evidence_graph");
    assert_eq!(plan["artifact"], "statewright.clu_plan");
    assert_eq!(ledger["active_hypothesis_id"], 1);
    assert!(
        plan["scoring_boundary"]
            .as_str()
            .unwrap()
            .contains("official SWE-bench verifier")
    );
    assert!(candidates.contains("candidate_lifecycle"));
    assert!(candidates.contains("official SWE-bench verifier"));
}

#[test]
fn structured_machine_routes_through_triage_and_audit() {
    let definition = super::hardcoded_bug_fix_machine_v2();

    assert_eq!(super::localized_next_state(&definition), "scope_selecting");
    assert_eq!(super::implementation_state_name(&definition), "editing");
    assert_eq!(
        super::evidence_refresh_state_name(&definition),
        "patch_planning"
    );
    assert_eq!(
        super::failure_triage_state_name(&definition),
        "failure_triage"
    );
    assert_eq!(
        super::trusted_pass_state_name(&definition),
        "completion_audit"
    );
    assert!(definition.states.contains_key("patch_planning"));
    assert!(definition.states.contains_key("micro_validation"));
    assert!(definition.states.contains_key("task_evidence_acquisition"));
    assert!(definition.states.contains_key("completion_audit"));
    let evidence_state = &definition.states["task_evidence_acquisition"];
    assert_eq!(evidence_state.max_iterations, Some(2));
    assert_eq!(evidence_state.safe_next.as_deref(), Some("failure_triage"));
    let evidence_tools = evidence_state.allowed_tools.as_ref().unwrap();
    assert!(evidence_tools.contains(&"write_task_reproducer".to_string()));
    assert!(evidence_tools.contains(&"run_task_reproducer".to_string()));
    assert!(!evidence_tools.iter().any(|tool| super::is_write_tool(tool)));
    assert_eq!(
        transition_target(
            &definition,
            "task_evidence_acquisition",
            "TASK_EVIDENCE_FIXED"
        ),
        "completion_audit"
    );
    assert_eq!(
        transition_target(
            &definition,
            "task_evidence_acquisition",
            "TASK_EVIDENCE_REPAIR"
        ),
        "failure_triage"
    );
    assert_eq!(
        transition_target(
            &definition,
            "task_evidence_acquisition",
            "TASK_EVIDENCE_UNAVAILABLE"
        ),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "task_evidence_acquisition", "DONE"),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "task_evidence_acquisition", "FAIL"),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "micro_validation", "VALIDATION_FEEDBACK_ONLY"),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "micro_validation", "VALIDATION_UNAVAILABLE"),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "completion_audit", "VALIDATION_FEEDBACK_ONLY"),
        "failure_triage"
    );
    assert_eq!(
        transition_target(&definition, "completion_audit", "VALIDATION_UNAVAILABLE"),
        "failure_triage"
    );

    if let Err(report) = statewright_agent::validator::validate_agent_machine(&definition) {
        panic!("structured machine should validate: {:?}", report.errors);
    }
}

#[test]
fn post_patch_task_evidence_delta_routes_are_typed_and_bounded() {
    assert_eq!(
        super::task_evidence_transition_for_output("SW_TASK_REPRODUCER_DELTA=fixed\n"),
        "TASK_EVIDENCE_FIXED"
    );
    assert_eq!(
        super::task_evidence_transition_for_output(
            "SW_TASK_REPRODUCER_DELTA=changed_fail\n"
        ),
        "TASK_EVIDENCE_CHANGED"
    );
    assert_eq!(
        super::task_evidence_transition_for_output(
            "SW_TASK_REPRODUCER_DELTA=unchanged_fail\n"
        ),
        "TASK_EVIDENCE_REPAIR"
    );
    assert_eq!(
        super::task_evidence_transition_for_output(
            "SW_TASK_REPRODUCER_STATUS=no_causal_oracle\n"
        ),
        "TASK_EVIDENCE_UNAVAILABLE"
    );
    assert!(!super::task_evidence_budget_exhausted(
        "task_evidence_acquisition",
        1
    ));
    assert!(super::task_evidence_budget_exhausted(
        "task_evidence_acquisition",
        2
    ));
    assert!(!super::task_evidence_budget_exhausted("editing", 20));
    assert!(super::task_evidence_fail_must_repair(
        true,
        "task_evidence_acquisition",
        "FAIL"
    ));
    assert!(!super::task_evidence_fail_must_repair(
        true,
        "editing",
        "FAIL"
    ));
    assert!(!super::task_evidence_fail_must_repair(
        false,
        "task_evidence_acquisition",
        "FAIL"
    ));
}

#[test]
fn post_patch_task_evidence_observations_do_not_rewind_causal_state() {
    let mut controller = super::causal_repair::CausalRepairController::new(None);
    for event in [
        super::causal_repair::CausalEvent::BaselineMapped { candidate_count: 1 },
        super::causal_repair::CausalEvent::NoCausalOracle {
            reason: "no task reproducer".to_string(),
        },
        super::causal_repair::CausalEvent::RepairPlanned {
            reason: "direct repair".to_string(),
        },
        super::causal_repair::CausalEvent::PatchApplied {
            patch_fingerprint: "candidate".to_string(),
        },
        super::causal_repair::CausalEvent::StructuralPass,
        super::causal_repair::CausalEvent::RegressionPass,
    ] {
        assert!(controller.record(event).accepted);
    }
    assert_eq!(
        controller.state(),
        super::causal_repair::CausalState::RegressionGreen
    );

    let mut controller = Some(controller);
    let mut checkpoints = None;
    super::record_post_patch_task_evidence_result(
        &mut controller,
        &mut checkpoints,
        ".",
        "write_task_reproducer",
        "SW_TASK_REPRODUCER_STATUS=qualified\n",
    );
    super::record_post_patch_task_evidence_result(
        &mut controller,
        &mut checkpoints,
        ".",
        "run_task_reproducer",
        "SW_TASK_REPRODUCER_DELTA=fixed\n",
    );

    assert_eq!(
        controller.unwrap().state(),
        super::causal_repair::CausalState::RegressionGreen
    );
}

#[test]
fn soft_validation_routes_to_repair_for_parent_but_review_for_child_candidate() {
    let _env_guard = crate::test_support::env_test_guard();
    let definition = super::hardcoded_bug_fix_machine_v2();
    unsafe {
        std::env::remove_var("SW_LEGACY_PRESERVE_UNAVAILABLE_VALIDATION");
        std::env::remove_var("DEPRECATED_SW_PRESERVE_UNAVAILABLE_VALIDATION");
        std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
        std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
    }

    assert_eq!(
        super::validation_unavailable_state_name(&definition),
        "failure_triage"
    );

    unsafe {
        std::env::set_var("SW_LEGACY_PRESERVE_UNAVAILABLE_VALIDATION", "1");
    }
    assert_eq!(
        super::validation_unavailable_state_name(&definition),
        "failure_triage"
    );
    unsafe {
        std::env::remove_var("SW_LEGACY_PRESERVE_UNAVAILABLE_VALIDATION");
        std::env::set_var("DEPRECATED_SW_PRESERVE_UNAVAILABLE_VALIDATION", "1");
    }
    assert_eq!(
        super::validation_unavailable_state_name(&definition),
        "completion_audit"
    );
    unsafe {
        std::env::remove_var("DEPRECATED_SW_PRESERVE_UNAVAILABLE_VALIDATION");
    }

    unsafe {
        std::env::set_var("SW_CANDIDATE_FANOUT_DEPTH", "1");
    }
    assert_eq!(
        super::validation_unavailable_state_name(&definition),
        "completion_audit"
    );
}

#[test]
fn speed_solver_machine_is_short_leash_and_validates() {
    let definition = super::hardcoded_bug_fix_machine_for_variant("speed");

    assert_eq!(super::localized_next_state(&definition), "targeting");
    assert_eq!(super::implementation_state_name(&definition), "editing");
    assert_eq!(super::failure_triage_state_name(&definition), "editing");
    assert_eq!(super::trusted_pass_state_name(&definition), "review");
    assert_eq!(definition.states["targeting"].max_iterations, Some(4));
    assert_eq!(definition.states["editing"].max_iterations, Some(7));
    assert_eq!(
        definition.states["micro_validation"].max_iterations,
        Some(2)
    );
    assert_eq!(
        transition_target(&definition, "micro_validation", "VALIDATION_UNAVAILABLE"),
        "review"
    );
    assert_eq!(
        transition_target(&definition, "micro_validation", "COLLECTION_ERROR"),
        "editing"
    );

    if let Err(report) = statewright_agent::validator::validate_agent_machine(&definition) {
        panic!("speed solver machine should validate: {:?}", report.errors);
    }
}

#[test]
fn unknown_machine_variant_defaults_to_structured_without_aborting() {
    let _env_guard = crate::test_support::env_test_guard();
    unsafe {
        std::env::remove_var("DEPRECATED_SW_UNKNOWN_MACHINE_LEGACY_FALLBACK");
    }
    let definition = super::hardcoded_bug_fix_machine_for_variant("typo-machine");
    assert_eq!(super::implementation_state_name(&definition), "editing");
    assert!(definition.states.contains_key("completion_audit"));

    unsafe {
        std::env::set_var("DEPRECATED_SW_UNKNOWN_MACHINE_LEGACY_FALLBACK", "1");
    }
    let definition = super::hardcoded_bug_fix_machine_for_variant("typo-machine");
    assert_eq!(
        super::implementation_state_name(&definition),
        "implementing"
    );
    assert!(!definition.states.contains_key("completion_audit"));
    unsafe {
        std::env::remove_var("DEPRECATED_SW_UNKNOWN_MACHINE_LEGACY_FALLBACK");
    }
}

fn transition_target(definition: &super::MachineDefinition, state: &str, event: &str) -> String {
    definition
        .states
        .get(state)
        .and_then(|state_def| state_def.on.get(event))
        .map(|transition| transition.target().to_string())
        .expect("transition should exist")
}

#[test]
fn problem_shape_machine_routes_weak_promoted_scope_through_tournament_lane() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 80), ("pkg/nearby.py", 70)],
        false,
        true,
        vec![super::SourceTestCandidate {
            path: "tests/test_fix.py".to_string(),
            score: 90,
            reason: "source adjacent".to_string(),
            trust_tier: "edited_source_adjacent".to_string(),
        }],
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 900, 10);
    let mut definition = super::hardcoded_bug_fix_machine_v2();

    let changes = super::apply_problem_shape_machine_policy(&mut definition, &policy);

    assert!(
        changes
            .iter()
            .any(|change| change.contains("lane=ambiguous"))
    );
    assert_eq!(definition.states["scope_selecting"].max_iterations, Some(5));
    assert_eq!(definition.states["editing"].max_iterations, Some(6));
    assert_eq!(
        transition_target(&definition, "failure_triage", "SAME_FAILURE"),
        "hypothesizing"
    );
    assert_eq!(
        transition_target(&definition, "failure_triage", "TESTS_FAIL"),
        "hypothesizing"
    );
    if let Err(report) = statewright_agent::validator::validate_agent_machine(&definition) {
        panic!("problem-shape machine should validate: {:?}", report.errors);
    }
}

#[test]
fn problem_shape_machine_keeps_focused_locus_on_patch_repair() {
    let shape = problem_shape_from_scores(
        &[("pkg/fix.py", 200), ("pkg/nearby.py", 80)],
        true,
        false,
        Vec::new(),
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 120, 2);
    let mut definition = super::hardcoded_bug_fix_machine_v2();

    let changes = super::apply_problem_shape_machine_policy(&mut definition, &policy);

    assert!(changes.iter().any(|change| change.contains("lane=focused")));
    assert_eq!(definition.states["scope_selecting"].max_iterations, Some(3));
    assert_eq!(definition.states["editing"].max_iterations, Some(7));
    assert_eq!(
        transition_target(&definition, "failure_triage", "SAME_FAILURE"),
        "patch_planning"
    );
    assert_eq!(
        transition_target(&definition, "failure_triage", "TESTS_FAIL"),
        "patch_planning"
    );
    if let Err(report) = statewright_agent::validator::validate_agent_machine(&definition) {
        panic!(
            "focused problem-shape machine should validate: {:?}",
            report.errors
        );
    }
}

#[test]
fn problem_shape_machine_routes_untrusted_source_scope_first() {
    let ranked = vec![
        ("pkg/fix.py".to_string(), 10),
        ("pkg/noise.py".to_string(), 70),
    ];
    let explicit = vec!["pkg/fix.py".to_string()];
    let regions = HashMap::new();
    let contexts = HashMap::new();
    let shape = super::ProblemShape::from_ranked_files(
        &ranked,
        &explicit,
        &regions,
        &contexts,
        false,
        &[],
        &[],
        &[],
        false,
        8,
    );
    let policy = super::CluSolverPolicy::from_problem_shape(&shape, 75, 2);
    let mut definition = super::hardcoded_bug_fix_machine_v2();

    let changes = super::apply_problem_shape_machine_policy(&mut definition, &policy);

    assert_eq!(policy.profile, "weak_scope_exploration");
    assert!(
        changes
            .iter()
            .any(|change| change.contains("lane=exploratory"))
    );
    assert_eq!(definition.states["scope_selecting"].max_iterations, Some(7));
    assert_eq!(definition.states["editing"].max_iterations, Some(5));
    assert_eq!(
        transition_target(&definition, "failure_triage", "SAME_FAILURE"),
        "scope_selecting"
    );
    if let Err(report) = statewright_agent::validator::validate_agent_machine(&definition) {
        panic!(
            "untrusted focused problem-shape machine should validate: {:?}",
            report.errors
        );
    }
}

#[test]
fn legacy_machine_keeps_existing_route_names() {
    let definition = super::hardcoded_bug_fix_machine();

    assert_eq!(super::localized_next_state(&definition), "planning");
    assert_eq!(
        super::implementation_state_name(&definition),
        "implementing"
    );
    assert_eq!(
        super::failure_triage_state_name(&definition),
        "implementing"
    );
    assert_eq!(super::trusted_pass_state_name(&definition), "review");
}

#[test]
fn llm_transport_error_classifier_retries_transport_not_parse() {
    let no_response = statewright_agent::ollama_client::OllamaError::NoResponse;
    let parse_error = statewright_agent::ollama_client::OllamaError::ParseError("bad json".into());

    assert!(super::retryable_llm_transport_error(&no_response));
    assert!(!super::retryable_llm_transport_error(&parse_error));
}

#[test]
fn llm_transport_backoff_uses_exponential_backoff_with_jitter() {
    let first = super::llm_transport_backoff_secs(1);
    assert!(
        (15..=22).contains(&first),
        "first failure delay should be 15s plus jitter, got {}",
        first
    );

    let third = super::llm_transport_backoff_secs(3);
    assert!(
        (60..=90).contains(&third),
        "third failure delay should be 60s plus jitter, got {}",
        third
    );

    let capped = super::llm_transport_backoff_secs(10);
    assert!(
        (120..=150).contains(&capped),
        "capped failure delay should be 120s plus jitter, got {}",
        capped
    );
}

#[test]
fn exhausted_hypothesis_is_not_reactivated_by_stale_path_promotion() {
    let mut hypotheses = vec![
        super::PatchHypothesis {
            id: 1,
            path: "pkg/first.py".to_string(),
            score: 100,
            reason: "first".to_string(),
        },
        super::PatchHypothesis {
            id: 2,
            path: "pkg/second.py".to_string(),
            score: 90,
            reason: "second".to_string(),
        },
    ];
    let mut active_index = 1;

    let promoted = super::promote_patch_hypothesis_path(
        &mut hypotheses,
        &mut active_index,
        "pkg/first.py",
        "stale read path",
    );

    assert!(promoted.is_none());
    assert_eq!(active_index, 1);
}

#[test]
fn label_scope_keys_are_stable_baseline_identities() {
    assert_eq!(
        super::candidate_validation::label_scope_key(
            "backends.sqlite.tests.SchemaTests.test_reserved_table_name"
        ),
        "__test_label__/backends.sqlite.tests.SchemaTests.test_reserved_table_name"
    );
}
