use serde::{Deserialize, Serialize};

/// Provider totals are exact only when the host TUI exposes them. They are
/// normalized here so gateway reports can compare adapters without retaining
/// provider transcripts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct TokenUsage {
    #[serde(default, alias = "inputTokens")]
    pub input_tokens: u64,
    #[serde(default, alias = "cachedInputTokens")]
    pub cached_input_tokens: u64,
    #[serde(default, alias = "outputTokens")]
    pub output_tokens: u64,
    #[serde(default, alias = "reasoningOutputTokens")]
    pub reasoning_output_tokens: u64,
    #[serde(default, alias = "totalTokens")]
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeUsageReport {
    pub sequence: u64,
    pub state: String,
    pub state_epoch: u64,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// exact, mixed, estimated, or unavailable.
    #[serde(default = "default_precision")]
    pub precision: String,
    #[serde(default)]
    pub token_usage: TokenUsage,
}

fn default_precision() -> String {
    "unavailable".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeToolReport {
    pub sequence: u64,
    pub state: String,
    pub state_epoch: u64,
    pub invocation_id: String,
    pub tool: String,
    #[serde(default)]
    pub tool_type: String,
    #[serde(default)]
    pub result_bytes: u64,
    #[serde(default)]
    pub estimated_input_tokens: u64,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolUsage {
    pub invocation_id: String,
    pub tool: String,
    pub tool_type: String,
    pub source: String,
    pub result_bytes: u64,
    pub estimated_input_tokens: u64,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateUsageSummary {
    pub state: String,
    pub state_epoch: u64,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub precision: String,
    pub token_usage: TokenUsage,
    pub tool_result_bytes: u64,
    pub estimated_tool_output_tokens: u64,
    pub non_tool_tokens: u64,
    pub tool_count: u64,
    pub context_budget_bytes: Option<u64>,
    pub context_budget_percent: Option<f64>,
    pub transition: Option<TransitionUsage>,
    pub tools: Vec<ToolUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionUsage {
    pub event: String,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_summary: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageLedger {
    state_epoch: u64,
    state: Option<StateUsageSummary>,
    history: Vec<StateUsageSummary>,
    last_sequence: u64,
}

impl UsageLedger {
    pub fn start(&mut self, state: &str, context_budget_bytes: Option<u64>) {
        self.state_epoch = 1;
        self.last_sequence = 0;
        self.history.clear();
        self.state = Some(empty_state(state, self.state_epoch, context_budget_bytes));
    }

    pub fn transition(
        &mut self,
        from: &str,
        to: &str,
        event: &str,
        decision_summary: Option<String>,
        context_budget_bytes: Option<u64>,
    ) {
        if let Some(current) = self.state.as_mut() {
            if current.state == from {
                current.transition = Some(TransitionUsage {
                    event: event.to_string(),
                    from: from.to_string(),
                    to: to.to_string(),
                    decision_summary,
                });
            }
        }
        if let Some(completed) = self.state.take() {
            self.history.push(completed);
        }
        self.state_epoch += 1;
        self.last_sequence = 0;
        self.state = Some(empty_state(to, self.state_epoch, context_budget_bytes));
    }

    pub fn report_usage(&mut self, report: RuntimeUsageReport) -> Result<(), String> {
        self.validate(report.sequence, &report.state, report.state_epoch)?;
        let state = self.state.as_mut().expect("validated state");
        state.provider = report.provider;
        state.model = report.model;
        state.effort = report.effort;
        state.precision = report.precision;
        state.token_usage = report.token_usage;
        update_derived(state);
        self.last_sequence = report.sequence;
        Ok(())
    }

    pub fn report_tool(&mut self, report: RuntimeToolReport) -> Result<(), String> {
        self.validate(report.sequence, &report.state, report.state_epoch)?;
        let state = self.state.as_mut().expect("validated state");
        if state
            .tools
            .iter()
            .any(|tool| tool.invocation_id == report.invocation_id)
        {
            self.last_sequence = report.sequence;
            return Ok(());
        }
        state.tools.push(ToolUsage {
            invocation_id: report.invocation_id,
            tool: report.tool,
            tool_type: report.tool_type,
            source: report.source,
            result_bytes: report.result_bytes,
            estimated_input_tokens: report.estimated_input_tokens,
            is_error: report.is_error,
        });
        update_derived(state);
        self.last_sequence = report.sequence;
        Ok(())
    }

    pub fn note_gateway_tool(&mut self, tool: &str, result_bytes: u64, is_error: bool) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        let invocation_id = format!("gateway:{}:{}", state.state_epoch, state.tools.len() + 1);
        state.tools.push(ToolUsage {
            invocation_id,
            tool: tool.to_string(),
            tool_type: "mcp".to_string(),
            source: "gateway".to_string(),
            result_bytes,
            estimated_input_tokens: result_bytes.div_ceil(4),
            is_error,
        });
        update_derived(state);
    }

    pub fn summary(&self) -> Option<StateUsageSummary> {
        self.state.clone()
    }

    pub fn summaries(&self) -> Vec<StateUsageSummary> {
        let mut summaries = self.history.clone();
        if let Some(current) = self.summary() {
            summaries.push(current);
        }
        summaries
    }

    fn validate(&self, sequence: u64, state: &str, state_epoch: u64) -> Result<(), String> {
        let current = self.state.as_ref().ok_or("No active usage state")?;
        if state != current.state || state_epoch != current.state_epoch {
            return Err(format!(
                "Usage report does not match active state '{}'/epoch {}",
                current.state, current.state_epoch
            ));
        }
        if sequence <= self.last_sequence {
            return Err("Usage report sequence is stale or duplicated".to_string());
        }
        Ok(())
    }
}

fn empty_state(
    state: &str,
    state_epoch: u64,
    context_budget_bytes: Option<u64>,
) -> StateUsageSummary {
    StateUsageSummary {
        state: state.to_string(),
        state_epoch,
        provider: String::new(),
        model: None,
        effort: None,
        precision: "unavailable".to_string(),
        token_usage: TokenUsage::default(),
        tool_result_bytes: 0,
        estimated_tool_output_tokens: 0,
        non_tool_tokens: 0,
        tool_count: 0,
        context_budget_bytes,
        context_budget_percent: None,
        transition: None,
        tools: Vec::new(),
    }
}

fn update_derived(state: &mut StateUsageSummary) {
    state.tool_result_bytes = state.tools.iter().map(|tool| tool.result_bytes).sum();
    state.estimated_tool_output_tokens = state
        .tools
        .iter()
        .map(|tool| tool.estimated_input_tokens)
        .sum();
    state.tool_count = state.tools.len() as u64;
    state.non_tool_tokens = state
        .token_usage
        .total_tokens
        .saturating_sub(state.estimated_tool_output_tokens);
    state.context_budget_percent = state.context_budget_bytes.and_then(|budget| {
        (budget > 0).then(|| (state.tool_result_bytes as f64 / budget as f64) * 100.0)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_exact_totals_and_tool_estimates_without_payloads() {
        let mut ledger = UsageLedger::default();
        ledger.start("analyze", Some(100));
        ledger
            .report_usage(RuntimeUsageReport {
                sequence: 1,
                state: "analyze".into(),
                state_epoch: 1,
                provider: "codex".into(),
                model: Some("gpt-5.6-sol".into()),
                effort: Some("high".into()),
                precision: "exact".into(),
                token_usage: TokenUsage {
                    total_tokens: 50,
                    ..Default::default()
                },
            })
            .unwrap();
        ledger
            .report_tool(RuntimeToolReport {
                sequence: 2,
                state: "analyze".into(),
                state_epoch: 1,
                invocation_id: "tool-1".into(),
                tool: "Read".into(),
                tool_type: "command".into(),
                result_bytes: 40,
                estimated_input_tokens: 10,
                source: "adapter".into(),
                is_error: false,
            })
            .unwrap();
        let summary = ledger.summary().unwrap();
        assert_eq!(summary.non_tool_tokens, 40);
        assert_eq!(summary.context_budget_percent, Some(40.0));
        assert_eq!(summary.tools[0].tool, "Read");
    }

    #[test]
    fn rejects_stale_and_wrong_state_reports() {
        let mut ledger = UsageLedger::default();
        ledger.start("analyze", None);
        let report = RuntimeUsageReport {
            sequence: 1,
            state: "analyze".into(),
            state_epoch: 1,
            provider: "codex".into(),
            model: None,
            effort: None,
            precision: "exact".into(),
            token_usage: TokenUsage::default(),
        };
        ledger.report_usage(report.clone()).unwrap();
        assert!(ledger.report_usage(report).is_err());
        assert!(
            ledger
                .report_usage(RuntimeUsageReport {
                    state: "other".into(),
                    sequence: 2,
                    ..RuntimeUsageReport {
                        sequence: 0,
                        state: String::new(),
                        state_epoch: 1,
                        provider: String::new(),
                        model: None,
                        effort: None,
                        precision: String::new(),
                        token_usage: TokenUsage::default()
                    }
                })
                .is_err()
        );
    }

    #[test]
    fn retains_completed_state_at_transition() {
        let mut ledger = UsageLedger::default();
        ledger.start("collect", Some(1_000));
        ledger
            .report_usage(RuntimeUsageReport {
                sequence: 1,
                state: "collect".to_string(),
                state_epoch: 1,
                provider: "codex".to_string(),
                model: Some("gpt-5".to_string()),
                effort: None,
                precision: "exact".to_string(),
                token_usage: TokenUsage {
                    total_tokens: 120,
                    ..TokenUsage::default()
                },
            })
            .unwrap();
        ledger.transition("collect", "analyze", "complete", None, Some(2_000));

        let summaries = ledger.summaries();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].state, "collect");
        assert_eq!(summaries[0].token_usage.total_tokens, 120);
        assert_eq!(summaries[1].state, "analyze");
    }
}
