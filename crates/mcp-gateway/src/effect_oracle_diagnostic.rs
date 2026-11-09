//! Test-build-only policy ceiling control. Draft labels never enter a production
//! request or provider. Strings are parsed as data and are never executed.
use super::*;
use crate::resource_effects::{self, Compatibility, EffectBounds, EffectSet};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::Path,
};

fn optimistic_vector(mask: Option<u8>) -> Option<SemanticRiskVector> {
    let mask = mask?;
    EffectSet::try_from(mask).ok()?;
    let p = |yes| Probability::new(if yes { 1.0 } else { 0.0 }).unwrap();
    Some(SemanticRiskVector {
        read_only: p(mask & (resource_effects::WRITE | resource_effects::DESTROY) == 0),
        may_write: p(mask & resource_effects::WRITE != 0),
        reversible: p(mask & resource_effects::DESTROY == 0),
        destructive: p(mask & resource_effects::DESTROY != 0),
        irreversible: p(mask & resource_effects::DESTROY != 0),
        // Deliberately optimistic legacy control: no external mutation is
        // supplied to the vector. Actual deterministic exposure is retained.
        external_or_account_effect: p(false),
    })
}

fn rw_candidate(effect: ResolvedEffect) -> bool {
    matches!(
        effect,
        ResolvedEffect::ReadOnly | ResolvedEffect::LocalWrite
    )
}

#[derive(Default)]
struct Counts {
    permitted: usize,
    held_permitted: usize,
    forbidden: usize,
    admitted_forbidden: usize,
    unresolved: usize,
    admitted_unresolved: usize,
    held_permitted_bases: BTreeMap<String, usize>,
}

impl Counts {
    fn record(&mut self, mask: Option<u8>, admitted: bool, basis: &str) {
        match mask {
            None => {
                self.unresolved += 1;
                self.admitted_unresolved += usize::from(admitted);
            }
            Some(mask) if mask & resource_effects::DESTROY == 0 => {
                self.permitted += 1;
                if !admitted {
                    self.held_permitted += 1;
                    *self.held_permitted_bases.entry(basis.into()).or_default() += 1;
                }
            }
            Some(_) => {
                self.forbidden += 1;
                self.admitted_forbidden += usize::from(admitted);
            }
        }
    }
    fn json(&self) -> Value {
        json!({"permitted":self.permitted,"held_permitted":self.held_permitted,
            "held_permitted_percent":if self.permitted==0{None}else{Some(100.0*self.held_permitted as f64/self.permitted as f64)},
            "forbidden":self.forbidden,"admitted_forbidden":self.admitted_forbidden,
            "unresolved":self.unresolved,"admitted_unresolved":self.admitted_unresolved,
            "held_permitted_bases":self.held_permitted_bases})
    }
}

#[test]
fn oracle_scores_are_diagnostic_and_unknown_truth_never_supplies_a_vector() {
    assert!(optimistic_vector(None).is_none());
    assert!(optimistic_vector(Some(8)).is_none());
    let write = optimistic_vector(Some(resource_effects::WRITE)).unwrap();
    assert_eq!(write.may_write.get(), 1.0);
    assert_eq!(write.destructive.get(), 0.0);
    let destroy = optimistic_vector(Some(resource_effects::DESTROY)).unwrap();
    assert_eq!(destroy.destructive.get(), 1.0);
}

#[test]
#[ignore = "explicit hash-bound local corpus and NEW diagnostic output required"]
fn frozen_effect_policy_ceiling() {
    assert!(
        !SemanticShadowConfig::from_env().enabled,
        "diagnostic requires providers disabled; it never calls a provider"
    );
    let input_path = std::env::var("STATEWRIGHT_EFFECT_ORACLE_CASES").expect("cases required");
    let expected_hash = std::env::var("STATEWRIGHT_EFFECT_ORACLE_SHA256").expect("hash required");
    let output_path =
        std::env::var("STATEWRIGHT_EFFECT_ORACLE_OUTPUT").expect("NEW output required");
    assert!(std::fs::metadata(&input_path).unwrap().len() <= 2 * 1024 * 1024);
    let bytes = std::fs::read(&input_path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(digest, expected_hash, "input preimage changed");
    let input: Value = serde_json::from_slice(&bytes).unwrap();
    let private = input["classification"] == "private_sanitized_local_only";
    if private {
        assert_eq!(input["schema"], "statewright/private-effect-set-cases/v1");
        assert_eq!(input["privacy"]["manual_sanitized_review"], true);
        assert_eq!(input["privacy"]["local_only"], true);
        assert_eq!(
            Path::new(&input_path)
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap(),
            Path::new(&output_path)
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap(),
            "private diagnostic must remain in the same local-only directory"
        );
    } else {
        assert_eq!(input["schema"], "statewright/public-effect-set-cases/v1");
        assert_eq!(input["classification"], "public_command_data");
    }
    let cases = input["cases"].as_array().unwrap();
    assert!(!cases.is_empty() && cases.len() <= 1000);
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let mut baseline_counts = Counts::default();
    let mut legacy_counts = Counts::default();
    let mut oracle_counts = Counts::default();
    // Match v5's string-authoritative projection explicitly in this test
    // thread. This setter is absent from production builds.
    set_test_shell_ast_authority_enabled(Some(false));
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && id.len() <= 128 && seen.insert(id.to_owned()));
        let command = case["command"].as_str().unwrap();
        assert!(!command.is_empty() && command.len() <= 8192);
        let mask = if case["mask"].is_null() {
            None
        } else {
            let bits = u8::try_from(case["mask"].as_u64().expect("integer mask required")).unwrap();
            Some(
                EffectSet::try_from(bits)
                    .expect("valid effects required")
                    .bits(),
            )
        };
        let args = json!({"cmd":command});
        let baseline = assess_native_policy_rejection(None, "exec_command", &args, None);
        let (effect, basis) = baseline.resolve_effect_with_basis();
        let candidate = rw_candidate(effect);
        baseline_counts.record(mask, candidate, basis);

        let deterministic = baseline.deterministic.clone();
        let vector = optimistic_vector(mask);
        let receipt = SemanticAssessmentReceipt {
            tool: "exec_command".into(),
            state_intent: None,
            status: if vector.is_some() {
                SemanticAssessorStatus::Assessed
            } else {
                SemanticAssessorStatus::Unavailable
            },
            vector,
        };
        // Same production resolver, with hypothetical score authority only in
        // this in-memory test object. No config, native permission or structure
        // is modified. This is a ceiling control, never an accuracy result.
        let hypothetical = pipeline_from_parts(deterministic, receipt, true);
        let (legacy_effect, legacy_basis) = hypothetical.resolve_effect_with_basis();
        let legacy_candidate = rw_candidate(legacy_effect);
        legacy_counts.record(mask, legacy_candidate, legacy_basis);

        let oracle_compatibility = mask.map(|bits| {
            EffectBounds::exact(EffectSet::try_from(bits).unwrap())
                .compatibility(EffectSet::READ.union(EffectSet::WRITE))
        });
        let oracle_candidate = oracle_compatibility == Some(Compatibility::Compatible);
        let oracle_basis = match oracle_compatibility {
            Some(Compatibility::Compatible) => "supplied_effects_subset",
            Some(Compatibility::Forbidden) => "supplied_forbidden_effect",
            _ => "no_supplied_truth",
        };
        oracle_counts.record(mask, oracle_candidate, oracle_basis);
        rows.push(json!({"id":id,"expected":mask,
            "baseline":{"candidate_rw":candidate,"effect":effect.label(),"basis":basis},
            "legacy_optimistic_vector":{"candidate_rw":legacy_candidate,"effect":legacy_effect.label(),"basis":legacy_basis,
                "structurally_sufficient":hypothetical.has_sufficient_semantic_evidence()},
            "effect_subset_oracle":{"candidate_rw":oracle_candidate,"basis":oracle_basis}}));
    }
    set_test_shell_ast_authority_enabled(None);
    let hashes = [
        ("risk_assessment.rs", include_str!("risk_assessment.rs")),
        ("resource_effects.rs", include_str!("resource_effects.rs")),
        ("effect_evidence.rs", include_str!("effect_evidence.rs")),
        ("utility_effects.rs", include_str!("utility_effects.rs")),
        (
            "invocation_evidence.rs",
            include_str!("invocation_evidence.rs"),
        ),
        ("command_structure.rs", include_str!("command_structure.rs")),
        ("bash_classifier.rs", include_str!("bash_classifier.rs")),
        ("semantic_contract.rs", include_str!("semantic_contract.rs")),
        ("shell_ast_shadow.rs", include_str!("shell_ast_shadow.rs")),
        ("shell_redirect.rs", include_str!("shell_redirect.rs")),
        ("cli_options.rs", include_str!("cli_options.rs")),
        (
            "effect_oracle_diagnostic.rs",
            include_str!("effect_oracle_diagnostic.rs"),
        ),
        ("Cargo.lock", include_str!("../../../Cargo.lock")),
    ]
    .into_iter()
    .map(|(name, text)| {
        (
            name.to_owned(),
            json!(format!("{:x}", Sha256::digest(text.as_bytes()))),
        )
    })
    .collect::<serde_json::Map<_, _>>();
    let summary = json!({"baseline":baseline_counts.json(),"legacy_optimistic_vector":legacy_counts.json(),
        "effect_subset_oracle":oracle_counts.json()});
    let result = json!({"schema":"statewright/effect-policy-ceiling/v1","classification":input["classification"],
        "privacy":input["privacy"],"label_status":input["label_status"],"input_sha256":digest,
        "context":input["context"],"resource_effect_contract":resource_effects::VERSION,
        "compiled_source_sha256":hashes,"enforcement":"none","models_called":0,"commands_executed":0,
        "interpretation":"Counterfactual diagnostic. Legacy optimistic vector assumes local reversible changes in its scores; actual structural/effect floors remain. Effect-subset oracle assumes declared fixture scope only. Neither arm is classifier accuracy or execution authority.",
        "summary":summary,"rows":rows});
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(output_path).unwrap();
    serde_json::to_writer_pretty(&mut output, &result).unwrap();
    writeln!(output).unwrap();
    println!("EFFECT_POLICY_CEILING {summary}");
}
