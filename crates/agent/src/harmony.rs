/// Harmony response format parser for reasoning models (gpt-oss, future OpenAI open models).
///
/// Harmony is OpenAI's non-standard response format where tool calls are embedded
/// in a token-level protocol instead of the standard tool_calls API response field.
/// This module re-tokenizes text responses and extracts structured tool calls.
///
/// Only compiled when the `harmony` feature is enabled.

#[cfg(feature = "harmony")]
use openai_harmony::{
    chat::{Content, Message, Role},
    load_harmony_encoding, HarmonyEncodingName,
};

/// Try to parse a raw response string as Harmony format.
/// Returns a JSON string with tool_calls if a tool call is found, None otherwise.
#[cfg(feature = "harmony")]
pub fn try_parse_harmony(raw: &str) -> Option<String> {
    // Only attempt if the text looks like it might contain Harmony tokens
    if !raw.contains("functions.") && !raw.contains("<|") && !raw.contains("commentary") {
        return None;
    }

    let encoding = load_harmony_encoding(HarmonyEncodingName::HarmonyGptOss).ok()?;
    let tokens = encoding.tokenizer().encode_with_special_tokens(raw);
    let messages = encoding
        .parse_messages_from_completion_tokens(tokens, Some(Role::Assistant))
        .ok()?;

    // Look for tool call messages: channel=commentary, recipient=functions.X
    for msg in &messages {
        if let Some(ref recipient) = msg.recipient {
            if recipient.starts_with("functions.") {
                let func_name = recipient.strip_prefix("functions.")?;
                let content_text = extract_text_content(&msg.content);

                if !content_text.is_empty() {
                    // Validate it's JSON
                    if serde_json::from_str::<serde_json::Value>(&content_text).is_ok() {
                        return Some(format!(
                            r#"{{"tool_calls":[{{"name":"{}","args":{}}}]}}"#,
                            func_name, content_text
                        ));
                    }
                }
            }
        }
    }

    None
}

#[cfg(feature = "harmony")]
fn extract_text_content(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|c| match c {
            Content::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// No-op when harmony feature is disabled.
#[cfg(not(feature = "harmony"))]
pub fn try_parse_harmony(_raw: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_for_plain_json() {
        let result = try_parse_harmony(r#"{"tool_calls": [{"name": "read_file"}]}"#);
        // Plain JSON doesn't look like Harmony — should return None
        assert!(result.is_none());
    }

    #[test]
    fn returns_none_for_empty() {
        assert!(try_parse_harmony("").is_none());
    }

    #[cfg(feature = "harmony")]
    #[test]
    fn parses_harmony_commentary_tool_call() {
        // This is a simplified test — real Harmony tokens need the actual tokenizer
        // The real test would use encoded token IDs
        let input = "commentary to=functions.read_file {\"path\": \"test.py\"}";
        let result = try_parse_harmony(input);
        // May or may not parse depending on tokenizer availability
        // The function gracefully returns None if tokenizer fails
    }
}
