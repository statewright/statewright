//! Deterministic, provider-neutral pre-tool risk/exposure assessment.
//!
//! This is deliberately a shadow primitive: callers keep their existing
//! authorization checks. The assessment contains no arguments or payloads so
//! it is safe to log as a bounded staging receipt.

use crate::{bash_classifier::{self, OpClass}, protocol::ToolInfo};
use serde::Deserialize;
use std::sync::OnceLock;
use tokio::sync::mpsc;

#[cfg(test)]
use std::cell::{Cell, RefCell};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskBand { Low, Moderate, High, Critical }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposureBand { Local, External, Account, Unknown }

/// A bounded probability returned by a semantic assessor.  The dimensions in
/// [`SemanticRiskVector`] are intentionally independent rather than a single
/// mutually-exclusive classification.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Probability(f32);

impl Probability {
    pub fn new(value: f32) -> Result<Self, &'static str> {
        if value.is_finite() && (0.0..=1.0).contains(&value) {
            Ok(Self(value))
        } else {
            Err("probability must be finite and within 0.0..=1.0")
        }
    }

    pub fn get(self) -> f32 { self.0 }
}

/// Independent, Noul-like properties of a pre-tool operation.  `reversible`
/// and `irreversible` are not complements: an assessor may be uncertain, or
/// an operation may have partially recoverable effects.
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticRiskVector {
    pub read_only: Probability,
    pub may_write: Probability,
    pub reversible: Probability,
    pub destructive: Probability,
    pub irreversible: Probability,
    pub external_or_account_effect: Probability,
}

/// Lifecycle status for a semantic result.  These statuses are telemetry only;
/// none is consumed by authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticAssessorStatus {
    Disabled,
    Queued,
    Unavailable,
    Timeout,
    Malformed,
    QueueFull,
    Assessed,
}

/// Staging-only controls for the semantic branch.  Production is disabled
/// unless an operator both names the staging environment and opts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticShadowConfig {
    pub enabled: bool,
    pub queue_capacity: usize,
}

impl SemanticShadowConfig {
    pub fn from_values(environment: Option<&str>, enabled: Option<&str>, capacity: Option<&str>) -> Self {
        let enabled = matches!(environment, Some("staging")) && shadow_enabled_for(enabled);
        let queue_capacity = capacity
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (1..=1024).contains(value))
            .unwrap_or(64);
        Self { enabled, queue_capacity }
    }

    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var("STATEWRIGHT_ENV").ok().as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_ASSESSMENT").ok().as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_QUEUE_CAPACITY").ok().as_deref(),
        )
    }
}

/// The only context a future semantic worker may receive.  It contains
/// operation shape, never argument values, command text, paths, or payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticAssessmentRequest {
    pub tool_family: &'static str,
    pub tool_name: String,
    pub state_intent: Option<String>,
    pub argument_keys: Vec<String>,
    pub shell_executable: Option<String>,
    pub shell_flags: Vec<String>,
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
}

/// A provider-neutral seam for a later local/open-weight worker.  The worker
/// owns scheduling, timeout, and transport; this trait cannot authorize an
/// invocation and receives only [`SemanticAssessmentRequest`].
pub trait SemanticAssessor {
    fn assess(&self, request: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticAssessmentReceipt {
    pub tool: String,
    pub status: SemanticAssessorStatus,
    pub vector: Option<SemanticRiskVector>,
    pub state_intent: Option<String>,
}

/// The assessment that travels with a pre-tool pipeline response.  It is
/// deliberately separate from authorization: callers can observe the
/// deterministic heuristic, the semantic failsafe's state, and the resulting
/// conservative risk floor without giving semantic inference permission to
/// admit an invocation.
#[derive(Debug, Clone, PartialEq)]
pub struct RiskPipelineAssessment {
    pub deterministic: ShadowAssessment,
    pub semantic: SemanticAssessmentReceipt,
    pub effective_risk: RiskBand,
    pub semantic_failsafe_escalated: bool,
}

impl RiskPipelineAssessment {
    /// Redacted, stable response shape for adapters and hooks.  It contains
    /// labels and bounded probabilities only--never arguments, command text,
    /// paths, or payload values.
    pub fn visible_json(&self) -> serde_json::Value {
        let vector = self.semantic.vector.as_ref().map(|value| serde_json::json!({
            "read_only": value.read_only.get(),
            "may_write": value.may_write.get(),
            "reversible": value.reversible.get(),
            "destructive": value.destructive.get(),
            "irreversible": value.irreversible.get(),
            "external_or_account_effect": value.external_or_account_effect.get(),
        }));
        serde_json::json!({
            "deterministic_risk": format!("{:?}", self.deterministic.risk),
            "deterministic_exposure": format!("{:?}", self.deterministic.exposure),
            "deterministic_source": self.deterministic.source,
            "effective_risk": format!("{:?}", self.effective_risk),
            "semantic_status": format!("{:?}", self.semantic.status),
            "semantic_vector": vector,
            "semantic_failsafe_escalated": self.semantic_failsafe_escalated,
        })
    }
}

pub struct SemanticAssessmentJob {
    request: SemanticAssessmentRequest,
    response: Option<tokio::sync::oneshot::Sender<SemanticAssessmentReceipt>>,
}

#[derive(Clone)]
struct SemanticProviderConfig {
    endpoint: String,
    model: String,
    bearer_token: Option<String>,
    timeout: std::time::Duration,
}

impl SemanticProviderConfig {
    fn from_env() -> Option<Self> {
        let endpoint = std::env::var("STATEWRIGHT_SEMANTIC_RISK_PROVIDER_URL").ok()?;
        let model = std::env::var("STATEWRIGHT_SEMANTIC_RISK_MODEL").ok()?;
        if endpoint.trim().is_empty() || model.trim().is_empty() { return None; }
        let timeout_ms = std::env::var("STATEWRIGHT_SEMANTIC_RISK_TIMEOUT_MS")
            .ok().and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (50..=5_000).contains(value)).unwrap_or(1_500);
        Some(Self {
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            model,
            bearer_token: std::env::var("STATEWRIGHT_SEMANTIC_RISK_PROVIDER_TOKEN").ok().filter(|value| !value.is_empty()),
            timeout: std::time::Duration::from_millis(timeout_ms),
        })
    }
}

/// Bounded, non-blocking queue used by a future local/open-weight worker.  A
/// full queue yields telemetry only; it can never slow down or change a tool
/// authorization decision.
#[derive(Clone)]
pub struct SemanticAssessmentQueue {
    sender: mpsc::Sender<SemanticAssessmentJob>,
}

impl SemanticAssessmentQueue {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<SemanticAssessmentJob>) {
        let (sender, receiver) = mpsc::channel(capacity.max(1));
        (Self { sender }, receiver)
    }

    pub fn try_submit(&self, request: SemanticAssessmentRequest) -> Result<(), SemanticAssessorStatus> {
        self.try_submit_job(SemanticAssessmentJob { request, response: None })
    }

    fn try_submit_with_response(&self, request: SemanticAssessmentRequest) -> Result<tokio::sync::oneshot::Receiver<SemanticAssessmentReceipt>, SemanticAssessorStatus> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.try_submit_job(SemanticAssessmentJob { request, response: Some(sender) })?;
        Ok(receiver)
    }

    fn try_submit_job(&self, job: SemanticAssessmentJob) -> Result<(), SemanticAssessorStatus> {
        self.sender
            .try_send(job)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => SemanticAssessorStatus::QueueFull,
                mpsc::error::TrySendError::Closed(_) => SemanticAssessorStatus::Unavailable,
            })
    }
}

/// OpenAI-compatible response envelope. The provider receives only the
/// redacted operation shape and must return JSON containing the six fields.
#[derive(Deserialize)]
struct SemanticProviderResponse { choices: Vec<SemanticProviderChoice> }
#[derive(Deserialize)]
struct SemanticProviderChoice { message: SemanticProviderMessage }
#[derive(Deserialize)]
struct SemanticProviderMessage { content: Option<String> }
#[derive(Deserialize)]
struct SemanticVectorWire {
    read_only: f32, may_write: f32, reversible: f32, destructive: f32,
    irreversible: f32, external_or_account_effect: f32,
}

async fn assess_with_provider(
    client: &reqwest::Client,
    provider: &SemanticProviderConfig,
    request: &SemanticAssessmentRequest,
) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
    let request_shape = serde_json::json!({
        "tool_family": request.tool_family, "tool_name": request.tool_name,
        "state_intent": request.state_intent, "argument_keys": request.argument_keys,
        "shell_executable": request.shell_executable, "shell_flags": request.shell_flags,
        "read_only_hint": request.read_only_hint, "destructive_hint": request.destructive_hint,
        "open_world_hint": request.open_world_hint,
    });
    let body = serde_json::json!({
        "model": provider.model,
        "temperature": 0.0,
        "max_tokens": 160,
        "messages": [
            {"role":"system","content":"Return JSON only with independent numbers 0..1: read_only, may_write, reversible, destructive, irreversible, external_or_account_effect. Assess only the supplied redacted operation shape."},
            {"role":"user","content": request_shape.to_string()}
        ]
    });
    let mut call = client.post(format!("{}/chat/completions", provider.endpoint)).json(&body);
    if let Some(token) = &provider.bearer_token { call = call.bearer_auth(token); }
    let response = call.send().await.map_err(|error| {
        if error.is_timeout() { SemanticAssessorStatus::Timeout } else { SemanticAssessorStatus::Unavailable }
    })?.error_for_status().map_err(|_| SemanticAssessorStatus::Unavailable)?;
    let body = response.bytes().await.map_err(|error| {
        if error.is_timeout() { SemanticAssessorStatus::Timeout } else { SemanticAssessorStatus::Unavailable }
    })?;
    let envelope: SemanticProviderResponse = serde_json::from_slice(&body)
        .map_err(|_| SemanticAssessorStatus::Malformed)?;
    let content = envelope.choices.into_iter().next().and_then(|choice| choice.message.content)
        .ok_or(SemanticAssessorStatus::Malformed)?;
    let wire: SemanticVectorWire = serde_json::from_str(content.trim().trim_matches('`').trim_start_matches("json"))
        .map_err(|_| SemanticAssessorStatus::Malformed)?;
    Ok(SemanticRiskVector {
        read_only: Probability::new(wire.read_only).map_err(|_| SemanticAssessorStatus::Malformed)?,
        may_write: Probability::new(wire.may_write).map_err(|_| SemanticAssessorStatus::Malformed)?,
        reversible: Probability::new(wire.reversible).map_err(|_| SemanticAssessorStatus::Malformed)?,
        destructive: Probability::new(wire.destructive).map_err(|_| SemanticAssessorStatus::Malformed)?,
        irreversible: Probability::new(wire.irreversible).map_err(|_| SemanticAssessorStatus::Malformed)?,
        external_or_account_effect: Probability::new(wire.external_or_account_effect).map_err(|_| SemanticAssessorStatus::Malformed)?,
    })
}

fn spawn_semantic_worker(
    mut receiver: mpsc::Receiver<SemanticAssessmentJob>,
    receipts: mpsc::Sender<SemanticAssessmentReceipt>,
    provider: SemanticProviderConfig,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let client = reqwest::Client::builder().timeout(provider.timeout).build()
            .expect("semantic provider HTTP client must build");
        while let Some(job) = receiver.recv().await {
            let receipt = match assess_with_provider(&client, &provider, &job.request).await {
                Ok(vector) => SemanticAssessmentReceipt { tool: job.request.tool_name.clone(), status: SemanticAssessorStatus::Assessed, vector: Some(vector), state_intent: job.request.state_intent.clone() },
                Err(status) => semantic_receipt(&job.request, status),
            };
            if let Some(response) = job.response { let _ = response.send(receipt.clone()); }
            let _ = try_emit_semantic_receipt(&receipts, receipt);
        }
    })
}

/// The receipt channel is telemetry only. Saturation drops the newest receipt
/// immediately and never makes a pre-tool invocation wait.
fn try_emit_semantic_receipt(
    receipts: &mpsc::Sender<SemanticAssessmentReceipt>,
    receipt: SemanticAssessmentReceipt,
) -> bool {
    match receipts.try_send(receipt) {
        Ok(()) => true,
        Err(error) => {
            let dropped = error.into_inner();
            tracing::warn!(
                tool = dropped.tool,
                semantic_status = ?dropped.status,
                "dropping bounded semantic risk shadow receipt"
            );
            false
        }
    }
}

/// Evaluate a semantic request without exposing its result to authorization.
/// A future worker owns queueing and timeout policy; this pure seam lets that
/// worker report disabled, unavailable, timeout, malformed, or queue-full
/// outcomes in one bounded receipt.
pub fn evaluate_semantic<A: SemanticAssessor>(
    _tool: &str,
    request: &SemanticAssessmentRequest,
    assessor: Option<&A>,
) -> SemanticAssessmentReceipt {
    match assessor {
        None => SemanticAssessmentReceipt {
            tool: request.tool_name.clone(),
            status: SemanticAssessorStatus::Disabled,
            vector: None,
            state_intent: request.state_intent.clone(),
        },
        Some(assessor) => match assessor.assess(request) {
            Ok(vector) => SemanticAssessmentReceipt {
                tool: request.tool_name.clone(),
                status: SemanticAssessorStatus::Assessed,
                vector: Some(vector),
                state_intent: request.state_intent.clone(),
            },
            Err(status) => SemanticAssessmentReceipt {
                tool: request.tool_name.clone(),
                status,
                vector: None,
                state_intent: request.state_intent.clone(),
            },
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowAssessment {
    pub risk: RiskBand,
    pub exposure: ExposureBand,
    pub source: &'static str,
    /// Workflow intent is context for calibration only; it never changes the
    /// deterministic authorization decision in this shadow-only milestone.
    pub state_intent: Option<String>,
    semantic_request: Option<SemanticAssessmentRequest>,
}

/// The bounded record emitted by the shadow path.  It deliberately has no
/// argument, command, path, or payload field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowReceipt {
    pub tool: String,
    pub risk: RiskBand,
    pub exposure: ExposureBand,
    pub source: &'static str,
    pub state_intent: Option<String>,
}

#[cfg(test)]
thread_local! {
    static TEST_SHADOW_ENABLED: Cell<Option<bool>> = const { Cell::new(None) };
    static TEST_SHADOW_RECEIPTS: RefCell<Vec<ShadowReceipt>> = const { RefCell::new(Vec::new()) };
    static TEST_SEMANTIC_RECEIPTS: RefCell<Vec<SemanticAssessmentReceipt>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub fn set_test_shadow_enabled(enabled: Option<bool>) {
    TEST_SHADOW_ENABLED.with(|value| value.set(enabled));
}

#[cfg(test)]
pub fn take_test_shadow_receipts() -> Vec<ShadowReceipt> {
    TEST_SHADOW_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

#[cfg(test)]
pub fn take_test_semantic_receipts() -> Vec<SemanticAssessmentReceipt> {
    TEST_SEMANTIC_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

/// The global evaluator is inert unless a staging deployment opts in. This
/// keeps the kernel reusable without adding production telemetry by default.
pub fn shadow_enabled_for(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES"))
}

/// Emit a bounded receipt only when the deployment has explicitly opted in.
/// The boolean is intentionally returned for ingress tests and health metrics;
/// it says nothing about authorization, which remains deterministic.
pub fn emit_shadow(tool: &str, assessment: &ShadowAssessment) -> bool {
    let enabled = shadow_enabled_for(std::env::var("STATEWRIGHT_SHADOW_RISK_ASSESSMENT").ok().as_deref());
    #[cfg(test)]
    let enabled = TEST_SHADOW_ENABLED.with(|override_value| override_value.get().unwrap_or(enabled));
    emit_shadow_when(enabled, tool, assessment)
}

fn emit_shadow_when(enabled: bool, tool: &str, assessment: &ShadowAssessment) -> bool {
    if enabled {
        #[cfg(test)]
        TEST_SHADOW_RECEIPTS.with(|receipts| receipts.borrow_mut().push(ShadowReceipt {
            tool: tool.to_string(),
            risk: assessment.risk,
            exposure: assessment.exposure,
            source: assessment.source,
            state_intent: assessment.state_intent.clone(),
        }));
        tracing::info!(
            tool,
            risk = ?assessment.risk,
            exposure = ?assessment.exposure,
            source = assessment.source,
            state_intent = ?assessment.state_intent,
            "statewright pre-tool shadow assessment"
        );
        true
    } else {
        false
    }
}

/// Process-wide staging runtime. It exists only for an explicitly configured
/// staging provider; requests are bounded by the queue and provider timeout.
struct SemanticShadowRuntime {
    queue: SemanticAssessmentQueue,
}

static SEMANTIC_SHADOW_RUNTIME: OnceLock<SemanticShadowRuntime> = OnceLock::new();

fn semantic_receipt(request: &SemanticAssessmentRequest, status: SemanticAssessorStatus) -> SemanticAssessmentReceipt {
    SemanticAssessmentReceipt {
        tool: request.tool_name.clone(),
        status,
        vector: None,
        state_intent: request.state_intent.clone(),
    }
}

fn record_semantic_receipt(receipt: SemanticAssessmentReceipt) {
    #[cfg(test)]
    TEST_SEMANTIC_RECEIPTS.with(|receipts| receipts.borrow_mut().push(receipt.clone()));
    tracing::info!(
        tool = receipt.tool,
        semantic_status = ?receipt.status,
        state_intent = ?receipt.state_intent,
        assessed = receipt.vector.is_some(),
        "statewright semantic risk shadow receipt"
    );
}

fn start_semantic_shadow_runtime(
    config: &SemanticShadowConfig,
    receipts: mpsc::Sender<SemanticAssessmentReceipt>,
    provider: SemanticProviderConfig,
) -> SemanticShadowRuntime {
    let (queue, receiver) = SemanticAssessmentQueue::new(config.queue_capacity);
    spawn_semantic_worker(receiver, receipts, provider);
    SemanticShadowRuntime { queue }
}

fn start_shared_semantic_shadow_runtime(config: &SemanticShadowConfig, provider: SemanticProviderConfig) -> SemanticShadowRuntime {
    let (receipt_sender, mut receipt_receiver) = mpsc::channel(config.queue_capacity);
    let runtime = start_semantic_shadow_runtime(config, receipt_sender, provider);
    tokio::spawn(async move {
        while let Some(receipt) = receipt_receiver.recv().await {
            record_semantic_receipt(receipt);
        }
    });
    runtime
}

/// The common staging dispatcher. A queued request returns no immediate
/// receipt because its worker owns the eventual unavailable result.
fn dispatch_semantic_shadow(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    request: &SemanticAssessmentRequest,
) -> Option<SemanticAssessmentReceipt> {
    if !config.enabled {
        return Some(semantic_receipt(request, SemanticAssessorStatus::Disabled));
    }
    let Some(runtime) = runtime else {
        return Some(semantic_receipt(request, SemanticAssessorStatus::Unavailable));
    };
    runtime
        .queue
        .try_submit(request.clone())
        .err()
        .map(|status| semantic_receipt(request, status))
}

/// Submit the redacted operation shape through the staging provider worker.
/// The returned status is the exact immediate outcome: successful enqueue is
/// `Queued`; the later assessed, timeout, malformed, or unavailable receipt is
/// recorded by the worker without delaying authorization.
fn submit_semantic_pipeline(request: &SemanticAssessmentRequest) -> SemanticAssessmentReceipt {
    let config = SemanticShadowConfig::from_env();
    let provider = SemanticProviderConfig::from_env();
    let runtime = if config.enabled && provider.is_some() && tokio::runtime::Handle::try_current().is_ok() {
        Some(SEMANTIC_SHADOW_RUNTIME.get_or_init(|| start_shared_semantic_shadow_runtime(&config, provider.expect("provider checked"))))
    } else {
        None
    };
    submit_semantic_pipeline_with(&config, runtime, request)
}

async fn submit_semantic_pipeline_visible_with(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    timeout: std::time::Duration,
    request: &SemanticAssessmentRequest,
) -> SemanticAssessmentReceipt {
    if !config.enabled { return semantic_receipt(request, SemanticAssessorStatus::Disabled); }
    let Some(runtime) = runtime else { return semantic_receipt(request, SemanticAssessorStatus::Unavailable); };
    let receiver = match runtime.queue.try_submit_with_response(request.clone()) {
        Ok(receiver) => receiver,
        Err(status) => return semantic_receipt(request, status),
    };
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(receipt)) => receipt,
        Ok(Err(_)) => semantic_receipt(request, SemanticAssessorStatus::Unavailable),
        Err(_) => semantic_receipt(request, SemanticAssessorStatus::Timeout),
    }
}

fn submit_semantic_pipeline_with(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    request: &SemanticAssessmentRequest,
) -> SemanticAssessmentReceipt {
    let receipt = dispatch_semantic_shadow(config, runtime, request)
        .unwrap_or_else(|| semantic_receipt(request, SemanticAssessorStatus::Queued));
    record_semantic_receipt(receipt.clone());
    receipt
}

pub fn assess_shell(command: &str) -> ShadowAssessment {
    let classes = bash_classifier::classify(command);
    if classes.contains(&OpClass::Destructive) {
        return assessment(RiskBand::Critical, ExposureBand::Local, "shell");
    }
    if classes.contains(&OpClass::Network) || classes.contains(&OpClass::GitWrite) {
        return assessment(RiskBand::High, ExposureBand::External, "shell");
    }
    if classes.contains(&OpClass::FileWrite) || classes.contains(&OpClass::FileModify) {
        return assessment(RiskBand::Moderate, ExposureBand::Local, "shell");
    }
    if bash_classifier::readonly_capabilities(command).is_some() {
        return assessment(RiskBand::Low, ExposureBand::Local, "shell");
    }
    assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell")
}

/// Produce exactly one deterministic assessment for an actual invocation.
/// Shell commands are classified from their command text; all other calls use
/// registered MCP metadata plus the conservative name fallback.
pub fn assess_invocation(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> ShadowAssessment {
    let is_shell = matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "terminal" | "exec_command" | "run_command"
    );
    let mut result = if is_shell {
        arguments
            .get("command")
            .or_else(|| arguments.get("cmd"))
            .and_then(|value| value.as_str())
            .map(assess_shell)
            .unwrap_or_else(|| assess_mcp(tool, tool_name))
    } else {
        assess_mcp(tool, tool_name)
    };
    result.state_intent = state_intent.map(str::to_owned);
    result.semantic_request = Some(semantic_request(tool, tool_name, arguments, state_intent, is_shell));
    result
}

/// Run the pre-tool assessment pipeline with the staging provider posture.
/// A provider must be explicitly configured in an opted-in staging deployment;
/// otherwise the semantic branch is visibly `Unavailable` and cannot make a
/// deterministic decision less restrictive.
pub fn assess_pipeline(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> RiskPipelineAssessment {
    let deterministic = assess_invocation(tool, tool_name, arguments, state_intent);
    emit_shadow(tool_name, &deterministic);
    let semantic = deterministic
        .semantic_request
        .as_ref()
        .map(submit_semantic_pipeline)
        .unwrap_or(SemanticAssessmentReceipt {
            tool: "unknown".to_owned(),
            status: SemanticAssessorStatus::Malformed,
            vector: None,
            state_intent: None,
        });
    pipeline_from_parts(deterministic, semantic)
}

/// Async visible form for hook and adapter responses. It waits only for the
/// configured bounded provider window and never changes authorization.
pub async fn assess_pipeline_visible(
    tool: Option<&ToolInfo>, tool_name: &str, arguments: &serde_json::Value, state_intent: Option<&str>,
) -> RiskPipelineAssessment {
    let config = SemanticShadowConfig::from_env();
    let provider = SemanticProviderConfig::from_env();
    let runtime = if config.enabled && provider.is_some() && tokio::runtime::Handle::try_current().is_ok() {
        Some(SEMANTIC_SHADOW_RUNTIME.get_or_init(|| start_shared_semantic_shadow_runtime(&config, provider.clone().expect("provider checked"))))
    } else { None };
    assess_pipeline_visible_with_runtime(
        tool,
        tool_name,
        arguments,
        state_intent,
        &config,
        runtime,
        provider.map(|provider| provider.timeout).unwrap_or_default(),
    ).await
}

async fn assess_pipeline_visible_with_runtime(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    timeout: std::time::Duration,
) -> RiskPipelineAssessment {
    let deterministic = assess_invocation(tool, tool_name, arguments, state_intent);
    emit_shadow(tool_name, &deterministic);
    let semantic = match deterministic.semantic_request.as_ref() {
        Some(request) => submit_semantic_pipeline_visible_with(config, runtime, timeout, request).await,
        None => SemanticAssessmentReceipt { tool: "unknown".to_owned(), status: SemanticAssessorStatus::Malformed, vector: None, state_intent: None },
    };
    pipeline_from_parts(deterministic, semantic)
}

/// Provider-injected form used by a future calibrated worker and focused
/// tests.  The combination policy is monotonic: semantic inference may only
/// raise the deterministic risk floor.
pub fn assess_pipeline_with<A: SemanticAssessor>(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    assessor: Option<&A>,
) -> RiskPipelineAssessment {
    assess_pipeline_with_config(
        tool,
        tool_name,
        arguments,
        state_intent,
        assessor,
        &SemanticShadowConfig::from_env(),
    )
}

fn assess_pipeline_with_config<A: SemanticAssessor>(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    assessor: Option<&A>,
    config: &SemanticShadowConfig,
) -> RiskPipelineAssessment {
    let deterministic = assess_invocation(tool, tool_name, arguments, state_intent);
    let semantic = match deterministic.semantic_request.as_ref() {
        None => SemanticAssessmentReceipt {
            tool: "unknown".to_owned(),
            status: SemanticAssessorStatus::Malformed,
            vector: None,
            state_intent: None,
        },
        Some(request) if !config.enabled => semantic_receipt(request, SemanticAssessorStatus::Disabled),
        Some(request) => match assessor {
            Some(assessor) => evaluate_semantic(tool_name, request, Some(assessor)),
            None => semantic_receipt(request, SemanticAssessorStatus::Unavailable),
        },
    };
    pipeline_from_parts(deterministic, semantic)
}

fn pipeline_from_parts(
    deterministic: ShadowAssessment,
    semantic: SemanticAssessmentReceipt,
) -> RiskPipelineAssessment {
    let effective_risk = semantic_failsafe_floor(deterministic.risk, &semantic);
    let semantic_failsafe_escalated = effective_risk != deterministic.risk;
    RiskPipelineAssessment {
        deterministic,
        semantic,
        effective_risk,
        semantic_failsafe_escalated,
    }
}

fn semantic_failsafe_floor(deterministic: RiskBand, semantic: &SemanticAssessmentReceipt) -> RiskBand {
    let Some(vector) = semantic.vector.as_ref() else { return deterministic; };
    let semantic_floor = if vector.destructive.get() >= 0.85 || vector.irreversible.get() >= 0.85 {
        RiskBand::Critical
    } else if vector.external_or_account_effect.get() >= 0.85 {
        RiskBand::High
    } else if vector.may_write.get() >= 0.85 {
        RiskBand::Moderate
    } else {
        RiskBand::Low
    };
    if risk_rank(semantic_floor) > risk_rank(deterministic) { semantic_floor } else { deterministic }
}

fn risk_rank(risk: RiskBand) -> u8 {
    match risk {
        RiskBand::Low => 0,
        RiskBand::Moderate => 1,
        RiskBand::High => 2,
        RiskBand::Critical => 3,
    }
}

pub fn assess_mcp(tool: Option<&ToolInfo>, tool_name: &str) -> ShadowAssessment {
    if let Some(tool) = tool {
        if tool.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true) {
            let exposure = if tool.annotations.as_ref().and_then(|a| a.open_world_hint) == Some(true) {
                ExposureBand::External
            } else {
                ExposureBand::Local
            };
            return assessment(RiskBand::Low, exposure, "mcp_annotation");
        }
        if tool.annotations.as_ref().and_then(|a| a.destructive_hint) == Some(true) {
            return assessment(RiskBand::Critical, ExposureBand::Account, "mcp_annotation");
        }
    }
    let open_world = tool
        .and_then(|tool| tool.annotations.as_ref())
        .and_then(|annotations| annotations.open_world_hint)
        == Some(true);
    let lower = tool_name.to_ascii_lowercase();
    let words: Vec<_> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()).collect();
    let has = |verbs: &[&str]| words.iter().any(|word| verbs.contains(word));
    let result = if has(&["delete", "remove", "destroy", "revoke", "purge", "send", "publish", "deploy", "push"]) {
        assessment(RiskBand::High, ExposureBand::Account, "mcp_name")
    } else if has(&["create", "update", "write", "edit", "patch", "apply", "upload", "move", "rename"]) {
        assessment(RiskBand::Moderate, ExposureBand::Local, "mcp_name")
    } else if has(&["read", "get", "list", "search", "find", "query", "inspect", "status", "describe", "lookup"]) {
        assessment(RiskBand::Low, ExposureBand::Local, "mcp_name")
    } else {
        assessment(RiskBand::Moderate, ExposureBand::Unknown, "mcp_unknown")
    };
    if open_world && result.exposure == ExposureBand::Local {
        assessment(result.risk, ExposureBand::External, result.source)
    } else {
        result
    }
}

fn assessment(risk: RiskBand, exposure: ExposureBand, source: &'static str) -> ShadowAssessment {
    ShadowAssessment { risk, exposure, source, state_intent: None, semantic_request: None }
}

fn semantic_request(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    is_shell: bool,
) -> SemanticAssessmentRequest {
    const SAFE_ARGUMENT_KEYS: &[&str] = &[
        "args", "cmd", "command", "cwd", "path", "pattern", "query", "workdir",
    ];
    let mut argument_keys = arguments
        .as_object()
        .map(|object| {
            object
                .keys()
                .filter(|key| SAFE_ARGUMENT_KEYS.contains(&key.as_str()))
                .take(16)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    argument_keys.sort();

    // Shell command text is deliberately omitted until a grammar-aware
    // redactor can distinguish flags from operands and option values.
    let (shell_executable, shell_flags) = (None, Vec::new());
    let annotations = tool.and_then(|tool| tool.annotations.as_ref());
    SemanticAssessmentRequest {
        tool_family: if is_shell { "shell" } else { "mcp" },
        tool_name: bounded_metadata_label(tool_name),
        state_intent: state_intent.map(bounded_metadata_label),
        argument_keys,
        shell_executable,
        shell_flags,
        read_only_hint: annotations.and_then(|value| value.read_only_hint),
        destructive_hint: annotations.and_then(|value| value.destructive_hint),
        open_world_hint: annotations.and_then(|value| value.open_world_hint),
    }
}

fn bounded_metadata_label(value: &str) -> String {
    const MAX_METADATA_LABEL_BYTES: usize = 64;
    if value.len() <= MAX_METADATA_LABEL_BYTES
        && !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        value.to_owned()
    } else {
        "unknown".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_bands_cover_read_local_write_and_external_write() {
        assert_eq!(assess_shell("rg pattern src").risk, RiskBand::Low);
        assert_eq!(assess_shell("echo hi > out.txt"), assessment(RiskBand::Moderate, ExposureBand::Local, "shell"));
        assert_eq!(assess_shell("git push origin main"), assessment(RiskBand::High, ExposureBand::External, "shell"));
        assert_eq!(assess_shell("touch output.txt"), assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell"));
        assert_eq!(assess_shell("git switch -c feature").risk, RiskBand::Moderate);
    }

    #[test]
    fn mcp_prefers_registered_annotations_and_marks_unknown() {
        let reader: ToolInfo = serde_json::from_value(json!({"name":"opaque","inputSchema":{},"annotations":{"readOnlyHint":true}})).unwrap();
        assert_eq!(assess_mcp(Some(&reader), "opaque").risk, RiskBand::Low);
        assert_eq!(assess_mcp(None, "mcp__opaque__thing").exposure, ExposureBand::Unknown);
        assert_eq!(assess_mcp(None, "mcp__mail__send_email"), assessment(RiskBand::High, ExposureBand::Account, "mcp_name"));
    }

    #[test]
    fn invocation_uses_shell_text_once_and_carries_state_intent() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command": "rg policy crates"}),
            Some("exploratory_read_only"),
        );
        assert_eq!(assessment.risk, RiskBand::Low);
        assert_eq!(assessment.source, "shell");
        assert_eq!(assessment.state_intent.as_deref(), Some("exploratory_read_only"));
    }

    #[test]
    fn open_world_mutation_is_external_not_local() {
        let writer: ToolInfo = serde_json::from_value(json!({
            "name":"update_task", "inputSchema":{}, "annotations":{"openWorldHint":true}
        })).unwrap();
        assert_eq!(
            assess_mcp(Some(&writer), "update_task"),
            assessment(RiskBand::Moderate, ExposureBand::External, "mcp_name")
        );
    }

    #[test]
    fn shadow_gate_is_disabled_by_default_and_requires_explicit_opt_in() {
        assert!(!shadow_enabled_for(None));
        assert!(!shadow_enabled_for(Some("0")));
        assert!(shadow_enabled_for(Some("1")));
        assert!(shadow_enabled_for(Some("true")));
    }

    #[test]
    fn shadow_receipt_is_opt_in_and_never_accepts_invocation_arguments() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command":"rg policy crates"}),
            Some("inspect"),
        );
        let _ = take_test_semantic_receipts();
        assert!(!emit_shadow_when(false, "exec_command", &assessment));
        assert!(take_test_semantic_receipts().is_empty());
        assert!(emit_shadow_when(true, "exec_command", &assessment));
        // The receipt API takes only a tool name and bounded assessment: callers
        // cannot supply command text, paths, secrets, or JSON arguments.
    }

    #[test]
    fn test_receipt_capture_is_thread_local_and_redacted() {
        set_test_shadow_enabled(Some(true));
        let assessment = assess_shell("rg policy crates");
        assert!(emit_shadow("exec_command", &assessment));
        let receipts = take_test_shadow_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].tool, "exec_command");
        assert!(!format!("{:?}", receipts[0]).contains("rg policy crates"));
        set_test_shadow_enabled(None);
    }

    #[test]
    fn probabilities_are_bounded_and_dimensions_are_independent() {
        assert_eq!(Probability::new(-0.01), Err("probability must be finite and within 0.0..=1.0"));
        assert_eq!(Probability::new(1.01), Err("probability must be finite and within 0.0..=1.0"));
        assert!(Probability::new(f32::NAN).is_err());
        let vector = SemanticRiskVector {
            read_only: Probability::new(0.2).unwrap(),
            may_write: Probability::new(0.7).unwrap(),
            reversible: Probability::new(0.7).unwrap(),
            destructive: Probability::new(0.1).unwrap(),
            irreversible: Probability::new(0.4).unwrap(),
            external_or_account_effect: Probability::new(0.3).unwrap(),
        };
        // No pair is forced to sum to one: these are independent properties.
        assert_ne!(vector.reversible.get() + vector.irreversible.get(), 1.0);
        assert_ne!(vector.read_only.get() + vector.may_write.get(), 1.0);
    }

    #[test]
    fn semantic_request_redacts_argument_values_and_shell_paths() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({
                "command": "git --config-env=secret_key=PASSWORD diff /private/plan.txt --no-textconv",
                "token": "super-secret"
            }),
            Some("exploratory_read_only"),
        );
        let request = assessment.semantic_request.unwrap();
        assert_eq!(request.tool_family, "shell");
        assert!(request.shell_executable.is_none());
        assert!(request.shell_flags.is_empty());
        assert_eq!(request.argument_keys, vec!["command".to_string()]);
        let rendered = format!("{:?}", request);
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("/private/plan.txt"));
        assert!(!rendered.contains("PASSWORD"));
    }

    #[test]
    fn semantic_shell_shape_omits_all_command_tokens_and_bounds_metadata() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({
                "command": "API_TOKEN=super-secret /usr/bin/git -phunter2 --no-textconv /private/plan.txt"
            }),
            Some("exploratory_read_only"),
        );
        let request = assessment.semantic_request.unwrap();
        assert!(request.shell_executable.is_none());
        assert!(request.shell_flags.is_empty());
        let rendered = format!("{:?}", request);
        assert!(!rendered.contains("API_TOKEN"));
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("hunter2"));
        assert!(!rendered.contains("/private/plan.txt"));
    }

    #[test]
    fn semantic_request_omits_unknown_keys_and_oversized_metadata() {
        let oversized = "x".repeat(65);
        let assessment = assess_invocation(
            None,
            &oversized,
            &json!({"token": "secret", "path": "/private/plan.txt", "x-secret-key": "also-secret"}),
            Some(&oversized),
        );
        let request = assessment.semantic_request.unwrap();
        assert_eq!(request.tool_name, "unknown");
        assert_eq!(request.state_intent.as_deref(), Some("unknown"));
        assert_eq!(request.argument_keys, vec!["path".to_string()]);
        assert!(!format!("{:?}", request).contains("secret"));
    }

    #[test]
    fn semantic_receipts_use_only_the_bounded_request_tool_label() {
        struct UnusedAssessor;
        impl SemanticAssessor for UnusedAssessor {
            fn assess(&self, _: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                unreachable!("the disabled path does not invoke an assessor")
            }
        }
        let oversized = "untrusted-tool-name-".repeat(8);
        let assessment = assess_invocation(None, &oversized, &json!({"path":"/private/secret"}), None);
        let request = assessment.semantic_request.unwrap();
        let receipt = semantic_receipt(&request, SemanticAssessorStatus::Disabled);
        assert_eq!(receipt.tool, "unknown");
        assert!(!format!("{:?}", receipt).contains("untrusted-tool-name"));

        let evaluated = evaluate_semantic::<UnusedAssessor>(&oversized, &request, None);
        assert_eq!(evaluated.tool, "unknown");
        assert!(!format!("{:?}", evaluated).contains("untrusted-tool-name"));
    }

    #[test]
    fn disabled_semantic_dispatch_does_not_change_the_deterministic_receipt() {
        set_test_shadow_enabled(Some(true));
        let _ = take_test_shadow_receipts();
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command":"rg policy crates"}),
            Some("exploratory_read_only"),
        );
        assert!(emit_shadow("Bash", &assessment));
        let deterministic = take_test_shadow_receipts();
        let request = assessment.semantic_request.as_ref().unwrap();
        let semantic = dispatch_semantic_shadow(
            &SemanticShadowConfig::from_values(Some("production"), Some("true"), None),
            None,
            request,
        )
        .unwrap();
        assert_eq!(deterministic.len(), 1);
        assert_eq!(deterministic[0].risk, RiskBand::Low);
        assert_eq!(semantic.status, SemanticAssessorStatus::Disabled);
        assert!(semantic.vector.is_none());
        assert!(!format!("{:?}", semantic).contains("rg policy crates"));
        set_test_shadow_enabled(None);
    }

    #[test]
    fn provider_neutral_assessor_can_return_an_independent_vector() {
        struct FakeAssessor;
        impl SemanticAssessor for FakeAssessor {
            fn assess(&self, _: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Ok(SemanticRiskVector {
                    read_only: Probability::new(0.99).unwrap(),
                    may_write: Probability::new(0.01).unwrap(),
                    reversible: Probability::new(0.8).unwrap(),
                    destructive: Probability::new(0.0).unwrap(),
                    irreversible: Probability::new(0.0).unwrap(),
                    external_or_account_effect: Probability::new(0.0).unwrap(),
                })
            }
        }
        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret.txt"}), None, false);
        let vector = FakeAssessor.assess(&request).unwrap();
        assert_eq!(vector.read_only.get(), 0.99);
        assert_eq!(vector.may_write.get(), 0.01);
        assert_eq!(request.argument_keys, vec!["path".to_string()]);
    }

    #[test]
    fn fake_assessor_covers_representative_operation_classes() {
        struct MatrixAssessor;
        impl SemanticAssessor for MatrixAssessor {
            fn assess(&self, request: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                let (read_only, may_write, reversible, destructive, irreversible, external) = match request.tool_name.as_str() {
                    "read_file" => (0.99, 0.01, 1.0, 0.0, 0.0, 0.0),
                    "write_file" => (0.05, 0.95, 0.95, 0.05, 0.05, 0.0),
                    "delete_file" => (0.0, 1.0, 0.1, 0.99, 0.95, 0.0),
                    "account_mutation" => (0.0, 1.0, 0.4, 0.5, 0.5, 0.99),
                    _ => (0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
                };
                Ok(SemanticRiskVector {
                    read_only: Probability::new(read_only).unwrap(),
                    may_write: Probability::new(may_write).unwrap(),
                    reversible: Probability::new(reversible).unwrap(),
                    destructive: Probability::new(destructive).unwrap(),
                    irreversible: Probability::new(irreversible).unwrap(),
                    external_or_account_effect: Probability::new(external).unwrap(),
                })
            }
        }
        let assessor = MatrixAssessor;
        for (tool_name, expected_read_only, expected_destructive, expected_external) in [
            ("read_file", 0.99, 0.0, 0.0),
            ("write_file", 0.05, 0.05, 0.0),
            ("delete_file", 0.0, 0.99, 0.0),
            ("account_mutation", 0.0, 0.5, 0.99),
            ("unknown", 0.5, 0.5, 0.5),
        ] {
            let request = semantic_request(None, tool_name, &json!({"value":"redacted"}), None, false);
            let receipt = evaluate_semantic(tool_name, &request, Some(&assessor));
            let vector = receipt.vector.unwrap();
            assert_eq!(receipt.status, SemanticAssessorStatus::Assessed);
            assert_eq!(vector.read_only.get(), expected_read_only);
            assert_eq!(vector.destructive.get(), expected_destructive);
            assert_eq!(vector.external_or_account_effect.get(), expected_external);
        }
    }

    #[test]
    fn semantic_evaluation_records_disabled_and_provider_failures_without_a_policy_decision() {
        struct FailingAssessor(SemanticAssessorStatus);
        impl SemanticAssessor for FailingAssessor {
            fn assess(&self, _: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Err(self.0)
            }
        }
        let request = semantic_request(None, "opaque", &json!({"value":"secret"}), Some("inspect"), false);
        assert_eq!(
            evaluate_semantic::<FailingAssessor>("opaque", &request, None).status,
            SemanticAssessorStatus::Disabled,
        );
        for status in [
            SemanticAssessorStatus::Unavailable,
            SemanticAssessorStatus::Timeout,
            SemanticAssessorStatus::Malformed,
            SemanticAssessorStatus::QueueFull,
        ] {
            let receipt = evaluate_semantic("opaque", &request, Some(&FailingAssessor(status)));
            assert_eq!(receipt.status, status);
            assert!(receipt.vector.is_none());
            assert!(!format!("{:?}", receipt).contains("secret"));
        }
    }

    #[test]
    fn semantic_config_requires_staging_and_bounds_queue_capacity() {
        assert!(!SemanticShadowConfig::from_values(Some("production"), Some("true"), Some("2")).enabled);
        let configured = SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("2"));
        assert!(configured.enabled);
        assert_eq!(configured.queue_capacity, 2);
        assert_eq!(SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("0")).queue_capacity, 64);
        assert_eq!(SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("2048")).queue_capacity, 64);
    }

    #[tokio::test]
    async fn provider_returns_redacted_assessed_vector() {
        use axum::{Json, Router, routing::post};
        use std::sync::{Arc, Mutex};
        let (seen_sender, seen_receiver) = tokio::sync::oneshot::channel();
        let seen_sender = Arc::new(Mutex::new(Some(seen_sender)));
        let app = Router::new().route("/chat/completions", post({
            let seen_sender = seen_sender.clone();
            move |Json(body): Json<serde_json::Value>| {
                let seen_sender = seen_sender.clone();
                async move {
                    if let Some(sender) = seen_sender.lock().unwrap().take() { let _ = sender.send(body); }
                    Json(json!({"choices":[{"message":{"content":r#"{"read_only":0.1,"may_write":0.9,"reversible":0.7,"destructive":0.1,"irreversible":0.1,"external_or_account_effect":0.95}"#}}]}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let config = SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("1"));
        let provider = SemanticProviderConfig { endpoint, model: "test".into(), bearer_token: None, timeout: std::time::Duration::from_secs(1) };
        let (receipt_sender, _receipt_receiver) = mpsc::channel(1);
        let runtime = start_semantic_shadow_runtime(&config, receipt_sender, provider.clone());
        let pipeline = assess_pipeline_visible_with_runtime(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            &config,
            Some(&runtime),
            provider.timeout,
        ).await;
        assert_eq!(pipeline.semantic.status, SemanticAssessorStatus::Assessed);
        assert_eq!(pipeline.semantic.vector.unwrap().external_or_account_effect.get(), 0.95);
        assert_eq!(pipeline.deterministic.risk, RiskBand::Low);
        assert_eq!(pipeline.effective_risk, RiskBand::High);
        assert!(pipeline.semantic_failsafe_escalated);
        let seen = seen_receiver.await.unwrap().to_string();
        assert!(!seen.contains("/private/secret"));
        assert!(seen.contains("shell_executable") && seen.contains("shell_flags"));
    }

    #[tokio::test]
    async fn provider_body_timeout_is_not_reported_as_malformed() {
        use axum::{body::{Body, Bytes}, response::Response, routing::post, Router};
        use std::convert::Infallible;
        use tokio_stream::wrappers::ReceiverStream;

        let app = Router::new().route("/chat/completions", post(|| async {
            let (sender, receiver) = mpsc::channel(1);
            tokio::spawn(async move {
                let _ = sender.send(Ok::<Bytes, Infallible>(Bytes::from_static(b"{\"choices\":"))).await;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            });
            Response::builder()
                .header("content-type", "application/json")
                .body(Body::from_stream(ReceiverStream::new(receiver)))
                .unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let provider = SemanticProviderConfig {
            endpoint,
            model: "test".into(),
            bearer_token: None,
            timeout: std::time::Duration::from_millis(20),
        };
        let client = reqwest::Client::builder().timeout(provider.timeout).build().unwrap();
        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret"}), Some("inspect"), false);
        assert_eq!(assess_with_provider(&client, &provider, &request).await, Err(SemanticAssessorStatus::Timeout));
    }

    #[tokio::test]
    async fn semantic_queue_reports_full_and_closed() {
        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret"}), Some("inspect"), false);
        let (full_queue, _full_receiver) = SemanticAssessmentQueue::new(1);
        assert!(full_queue.try_submit(request.clone()).is_ok());
        assert_eq!(full_queue.try_submit(request.clone()), Err(SemanticAssessorStatus::QueueFull));

        let (closed_queue, closed_receiver) = SemanticAssessmentQueue::new(1);
        drop(closed_receiver);
        assert_eq!(closed_queue.try_submit(request.clone()), Err(SemanticAssessorStatus::Unavailable));

    }

    #[tokio::test]
    async fn semantic_dispatcher_uses_explicit_staging_config_and_bounded_worker() {
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
        );
        let disabled = SemanticShadowConfig::from_values(Some("production"), Some("true"), None);
        let disabled_receipt = dispatch_semantic_shadow(&disabled, None, &request).unwrap();
        assert_eq!(disabled_receipt.status, SemanticAssessorStatus::Disabled);

        let enabled = SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("1"));
        let (receipt_sender, mut receipt_receiver) = mpsc::channel(1);
        let provider = SemanticProviderConfig {
            endpoint: "http://127.0.0.1:1".into(), model: "test".into(), bearer_token: None,
            timeout: std::time::Duration::from_millis(50),
        };
        let runtime = start_semantic_shadow_runtime(&enabled, receipt_sender, provider);
        assert!(dispatch_semantic_shadow(&enabled, Some(&runtime), &request).is_none());
        let receipt = tokio::time::timeout(
            // The provider deadline remains 50ms; leave scheduler slack so
            // this test verifies bounded completion without assuming an idle
            // shared test runtime.
            std::time::Duration::from_millis(500),
            receipt_receiver.recv(),
        )
        .await
        .expect("bounded worker should emit promptly")
        .expect("bounded receipt sender should remain open");
        assert_eq!(receipt.status, SemanticAssessorStatus::Unavailable);
        assert!(receipt.vector.is_none());
    }

    #[test]
    fn full_bounded_receipt_channel_drops_telemetry_immediately() {
        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret"}), Some("inspect"), false);
        let (receipt_sender, mut receipt_receiver) = mpsc::channel(1);
        assert!(receipt_sender
            .try_send(semantic_receipt(&request, SemanticAssessorStatus::Disabled))
            .is_ok());
        assert!(!try_emit_semantic_receipt(
            &receipt_sender,
            semantic_receipt(&request, SemanticAssessorStatus::Unavailable),
        ));
        assert_eq!(receipt_receiver.try_recv().unwrap().status, SemanticAssessorStatus::Disabled);
        assert!(receipt_receiver.try_recv().is_err());
    }

    #[test]
    fn visible_pipeline_keeps_heuristic_as_floor_and_escalates_only_for_high_confidence_failsafes() {
        struct Failsafe;
        impl SemanticAssessor for Failsafe {
            fn assess(&self, _: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Ok(SemanticRiskVector {
                    read_only: Probability::new(0.99).unwrap(),
                    may_write: Probability::new(0.01).unwrap(),
                    reversible: Probability::new(0.1).unwrap(),
                    destructive: Probability::new(0.91).unwrap(),
                    irreversible: Probability::new(0.9).unwrap(),
                    external_or_account_effect: Probability::new(0.0).unwrap(),
                })
            }
        }
        let enabled = SemanticShadowConfig::from_values(Some("staging"), Some("true"), None);
        let pipeline = assess_pipeline_with_config(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            Some("inspect"),
            Some(&Failsafe),
            &enabled,
        );
        assert_eq!(pipeline.deterministic.risk, RiskBand::Low);
        assert_eq!(pipeline.effective_risk, RiskBand::Critical);
        assert!(pipeline.semantic_failsafe_escalated);
        let visible = pipeline.visible_json();
        assert_eq!(visible["semantic_status"], "Assessed");
        assert_eq!(visible["effective_risk"], "Critical");
        assert!(!visible.to_string().contains("/private/secret.txt"));

        let disabled = SemanticShadowConfig::from_values(Some("production"), Some("true"), None);
        let unavailable = assess_pipeline_with_config::<Failsafe>(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            Some("inspect"),
            None,
            &disabled,
        );
        assert_eq!(unavailable.semantic.status, SemanticAssessorStatus::Disabled);
        assert_eq!(unavailable.effective_risk, unavailable.deterministic.risk);
        assert!(!unavailable.semantic_failsafe_escalated);
    }

    #[test]
    fn semantic_failsafe_is_monotonic_across_all_risk_floors_and_fallbacks() {
        let vector = |may_write, destructive, irreversible, external_or_account_effect| SemanticRiskVector {
            read_only: Probability::new(0.99).unwrap(),
            may_write: Probability::new(may_write).unwrap(),
            reversible: Probability::new(0.99).unwrap(),
            destructive: Probability::new(destructive).unwrap(),
            irreversible: Probability::new(irreversible).unwrap(),
            external_or_account_effect: Probability::new(external_or_account_effect).unwrap(),
        };
        let assessed = |vector| SemanticAssessmentReceipt {
            tool: "read_file".to_owned(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(vector),
            state_intent: Some("inspect".to_owned()),
        };
        let cases = [
            (RiskBand::Low, assessed(vector(0.91, 0.01, 0.01, 0.01)), RiskBand::Moderate, true),
            (RiskBand::Low, assessed(vector(0.01, 0.01, 0.01, 0.91)), RiskBand::High, true),
            (RiskBand::Low, assessed(vector(0.01, 0.91, 0.01, 0.01)), RiskBand::Critical, true),
            (RiskBand::Low, assessed(vector(0.01, 0.01, 0.91, 0.01)), RiskBand::Critical, true),
            (RiskBand::Critical, assessed(vector(0.01, 0.01, 0.01, 0.01)), RiskBand::Critical, false),
        ];
        for (baseline, semantic, expected, escalated) in cases {
            let pipeline = pipeline_from_parts(assessment(baseline, ExposureBand::Local, "test"), semantic);
            assert_eq!(pipeline.effective_risk, expected);
            assert_eq!(pipeline.semantic_failsafe_escalated, escalated);
        }

        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret.txt"}), Some("inspect"), false);
        for status in [
            SemanticAssessorStatus::Disabled,
            SemanticAssessorStatus::Queued,
            SemanticAssessorStatus::Unavailable,
            SemanticAssessorStatus::Timeout,
            SemanticAssessorStatus::Malformed,
            SemanticAssessorStatus::QueueFull,
        ] {
            let pipeline = pipeline_from_parts(
                assessment(RiskBand::Critical, ExposureBand::Account, "test"),
                semantic_receipt(&request, status),
            );
            assert_eq!(pipeline.effective_risk, RiskBand::Critical, "{status:?}");
            assert!(!pipeline.semantic_failsafe_escalated, "{status:?}");
            assert_eq!(pipeline.visible_json()["semantic_status"], format!("{status:?}"));
        }
    }

    #[test]
    fn historical_risky_commands_are_assessed_without_execution() {
        // These commands occurred in the earlier workflow. They are inputs to
        // the assessor only: this test never invokes a shell or a provider.
        // `npm install` occurred in both plugins/executor and plugins/pi; this
        // classifier deliberately receives command text, not a working directory.
        struct NeverCalled;
        impl SemanticAssessor for NeverCalled {
            fn assess(&self, _: &SemanticAssessmentRequest) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                unreachable!("the unavailable replay path must not invoke an assessor")
            }
        }
        let staging = SemanticShadowConfig::from_values(Some("staging"), Some("true"), None);
        for (command, expected_risk, expected_exposure) in [
            (
                "git add plugins/executor/lib/workflow-preamble.mjs plugins/executor/lib/host-adapters.mjs plugins/executor/lib/managed-client-supervisor.mjs plugins/executor/tests/host-adapters.test.mjs plugins/executor/tests/managed-client-supervisor.test.mjs",
                RiskBand::Moderate,
                ExposureBand::Unknown,
            ),
            (
                "git commit -m \"fix(executor): reinforce workflow continuation\"",
                RiskBand::High,
                ExposureBand::External,
            ),
            ("npm install", RiskBand::Moderate, ExposureBand::Unknown),
        ] {
            let pipeline = assess_pipeline_with_config::<NeverCalled>(
                None,
                "Bash",
                &json!({"command": command}),
                Some("implement"),
                None,
                &staging,
            );
            assert_eq!(pipeline.deterministic.risk, expected_risk, "{command}");
            assert_eq!(pipeline.deterministic.exposure, expected_exposure, "{command}");
            assert_eq!(pipeline.semantic.status, SemanticAssessorStatus::Unavailable, "{command}");
            assert!(pipeline.semantic.vector.is_none(), "{command}");
            assert_eq!(pipeline.effective_risk, expected_risk, "{command}");
            assert!(!pipeline.semantic_failsafe_escalated, "{command}");
        }
    }

    #[test]
    fn visible_pipeline_submission_reports_the_actual_queue_full_outcome() {
        let request = semantic_request(None, "read_file", &json!({"path":"/private/secret"}), None, false);
        let enabled = SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("1"));
        let (queue, _receiver) = SemanticAssessmentQueue::new(1);
        assert!(queue.try_submit(request.clone()).is_ok());
        let runtime = SemanticShadowRuntime { queue };
        let receipt = submit_semantic_pipeline_with(&enabled, Some(&runtime), &request);
        assert_eq!(receipt.status, SemanticAssessorStatus::QueueFull);
        assert!(receipt.vector.is_none());
        assert!(!format!("{:?}", receipt).contains("/private/secret"));
    }
}
