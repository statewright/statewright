use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Debug, Clone)]
pub struct ModelRegistry {
    pub version: u32,
    pub defaults: ModelProfile,
    pub models: HashMap<String, ModelEntry>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ModelEntry {
    #[serde(default)]
    pub family_defaults: ModelProfile,
    #[serde(default)]
    pub sizes: HashMap<String, ModelProfile>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ModelProfile {
    pub tool_mode: Option<ToolMode>,
    pub reasoning: Option<bool>,
    pub response_field: Option<ResponseField>,
    pub history_window: Option<usize>,
    pub max_full_read_lines: Option<usize>,
    pub max_diff_lines: Option<usize>,
    pub unescape_tool_args: Option<bool>,
    pub single_quote_json: Option<bool>,
    pub num_ctx: Option<u32>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolMode {
    Native,
    Raw,
    Auto,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseField {
    Content,
    Reasoning,
}

/// Fully resolved profile — no Options.
#[derive(Debug, Clone)]
pub struct ResolvedProfile {
    pub tool_mode: ToolMode,
    pub reasoning: bool,
    pub response_field: ResponseField,
    pub history_window: usize,
    pub max_full_read_lines: usize,
    pub max_diff_lines: usize,
    pub unescape_tool_args: bool,
    pub single_quote_json: bool,
    pub num_ctx: u32,
}

impl ModelRegistry {
    pub fn builtin() -> Self {
        serde_json::from_str(include_str!("../model_registry.json"))
            .expect("embedded model_registry.json is invalid")
    }

    pub fn load(path: &str) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(Self::builtin)
    }

    pub fn resolve(&self, model_tag: &str) -> ResolvedProfile {
        let (family, size) = parse_model_tag(model_tag);

        let mut merged = self.defaults.clone();

        if let Some(entry) = self.models.get(family) {
            merge_profile(&mut merged, &entry.family_defaults);
            if let Some(size_profile) = size.and_then(|s| entry.sizes.get(s)) {
                merge_profile(&mut merged, size_profile);
            }
        }

        ResolvedProfile {
            tool_mode: merged.tool_mode.unwrap_or(ToolMode::Auto),
            reasoning: merged.reasoning.unwrap_or(false),
            response_field: merged.response_field.unwrap_or(ResponseField::Content),
            history_window: merged.history_window.unwrap_or(10),
            max_full_read_lines: merged.max_full_read_lines.unwrap_or(600),
            max_diff_lines: merged.max_diff_lines.unwrap_or(5),
            unescape_tool_args: merged.unescape_tool_args.unwrap_or(false),
            single_quote_json: merged.single_quote_json.unwrap_or(false),
            num_ctx: merged.num_ctx.unwrap_or(8192),
        }
    }
}

fn parse_model_tag(tag: &str) -> (&str, Option<&str>) {
    match tag.split_once(':') {
        Some((family, size)) => (family, Some(size)),
        None => (tag, None),
    }
}

fn merge_profile(base: &mut ModelProfile, from: &ModelProfile) {
    macro_rules! merge {
        ($f:ident) => { if from.$f.is_some() { base.$f = from.$f.clone(); } };
    }
    merge!(tool_mode);
    merge!(reasoning);
    merge!(response_field);
    merge!(history_window);
    merge!(max_full_read_lines);
    merge!(max_diff_lines);
    merge!(unescape_tool_args);
    merge!(single_quote_json);
    merge!(num_ctx);
}
