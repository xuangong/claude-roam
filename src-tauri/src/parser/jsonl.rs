//! JSONL parser for Claude session files

#![allow(dead_code)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::display::{ContentBlock, DisplayMessage, DisplayType};

/// Truncate a string to approximately max_bytes, respecting UTF-8 char boundaries
fn truncate_string(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }

    // Find the last valid char boundary before max_bytes
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}...", &s[..end])
}

/// Raw message from JSONL file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMessage {
    pub uuid: String,
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub message: MessageContent,
    #[serde(rename = "cacheKey")]
    pub cache_key: Option<String>,
    #[serde(rename = "isSidechain")]
    pub is_sidechain: Option<bool>,
}

/// Message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageContent {
    pub role: String,
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
}

/// Summary record type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryRecord {
    #[serde(rename = "type")]
    pub record_type: String,
    pub summary: String,
    #[serde(rename = "leafUuid")]
    pub leaf_uuid: String,
    pub timestamp: String,
}

/// File history snapshot type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHistorySnapshot {
    #[serde(rename = "type")]
    pub record_type: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub snapshot: serde_json::Value,
}

/// System record type (api_error, compact_boundary, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemRecord {
    pub uuid: String,
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(rename = "type")]
    pub record_type: String,
    pub subtype: Option<String>,
    pub error: Option<serde_json::Value>,
    #[serde(rename = "retryAttempt")]
    pub retry_attempt: Option<u32>,
    #[serde(rename = "maxRetries")]
    pub max_retries: Option<u32>,
    pub level: Option<String>,
    pub content: Option<String>,
}

/// JSONL line type - can be message, summary, or file history
#[derive(Debug, Clone)]
pub enum JsonlLine {
    Message(RawMessage),
    Summary(SummaryRecord),
    FileHistory(FileHistorySnapshot),
    System(SystemRecord),
    Unknown(serde_json::Value),
}

/// Parse a JSONL file and return DisplayMessages
pub fn parse_jsonl_file(path: &Path) -> Result<Vec<DisplayMessage>> {
    let file = File::open(path).context("Failed to open JSONL file")?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    let mut tree_index: u32 = 0;

    for (line_num, line) in reader.lines().enumerate() {
        let line = line.context(format!("Failed to read line {}", line_num + 1))?;

        if line.trim().is_empty() {
            continue;
        }

        match parse_jsonl_line(&line) {
            Ok(JsonlLine::Message(raw)) => {
                let display_messages = convert_to_display_messages(&raw, &mut tree_index);
                messages.extend(display_messages);
            }
            Ok(JsonlLine::System(sys)) => {
                if let Some(msg) = convert_system_to_display_message(&sys, &mut tree_index) {
                    messages.push(msg);
                }
            }
            Ok(JsonlLine::Summary(_)) | Ok(JsonlLine::FileHistory(_)) | Ok(JsonlLine::Unknown(_)) => {
                // Skip non-message records
            }
            Err(e) => {
                log::warn!("Failed to parse line {}: {}", line_num + 1, e);
            }
        }
    }

    Ok(messages)
}

/// Parse a single JSONL line
pub fn parse_jsonl_line(line: &str) -> Result<JsonlLine> {
    let value: serde_json::Value = serde_json::from_str(line)?;

    // Check record type first
    if let Some(type_str) = value.get("type").and_then(|v| v.as_str()) {
        match type_str {
            "summary" => {
                let summary: SummaryRecord = serde_json::from_value(value)?;
                return Ok(JsonlLine::Summary(summary));
            }
            "file-history-snapshot" => {
                let snapshot: FileHistorySnapshot = serde_json::from_value(value)?;
                return Ok(JsonlLine::FileHistory(snapshot));
            }
            "system" => {
                // System messages (api_error, compact_boundary, etc.)
                if value.get("uuid").is_some() {
                    if let Ok(sys) = serde_json::from_value::<SystemRecord>(value.clone()) {
                        return Ok(JsonlLine::System(sys));
                    }
                }
                return Ok(JsonlLine::Unknown(value));
            }
            _ => {}
        }
    }

    // Check if it's a message (has uuid and message fields)
    if value.get("uuid").is_some() && value.get("message").is_some() {
        let raw: RawMessage = serde_json::from_value(value)?;
        return Ok(JsonlLine::Message(raw));
    }

    Ok(JsonlLine::Unknown(value))
}

/// Convert a raw message to display messages
fn convert_to_display_messages(raw: &RawMessage, tree_index: &mut u32) -> Vec<DisplayMessage> {
    let mut display_messages = Vec::new();

    for block in &raw.message.content {
        let (display_type, tool_name, tool_id, tool_input, tool_content, stdout, stderr, return_code, thinking_content) = match block {
            ContentBlock::Text { .. } => {
                if raw.message.role == "user" {
                    (DisplayType::Human, None, None, None, None, None, None, None, None)
                } else {
                    (DisplayType::Assistant, None, None, None, None, None, None, None, None)
                }
            }
            ContentBlock::ToolUse { id, name, input } => {
                (DisplayType::ToolUse, Some(name.clone()), Some(id.clone()), Some(input.clone()), None, None, None, None, None)
            }
            ContentBlock::ToolResult { tool_use_id, content } => {
                (DisplayType::ToolResult, None, Some(tool_use_id.clone()), None, Some(content.clone()), None, None, None, None)
            }
            ContentBlock::Thinking { thinking } => {
                (DisplayType::Thinking, None, None, None, None, None, None, None, Some(thinking.clone()))
            }
            ContentBlock::CodeExecutionResult { stdout: s, stderr: e, return_code: r } => {
                (DisplayType::CodeResult, None, None, None, None, s.clone(), e.clone(), *r, None)
            }
            ContentBlock::ServerToolUse { name, server_tool_use_id, input } => {
                (DisplayType::ToolUse, Some(name.clone()), Some(server_tool_use_id.clone()), Some(input.clone()), None, None, None, None, None)
            }
        };

        let msg = DisplayMessage {
            display_type,
            uuid: raw.uuid.clone(),
            parent_uuid: raw.parent_uuid.clone(),
            timestamp: raw.timestamp.clone(),
            tree_index: *tree_index,
            blocks: vec![block.clone()],
            tool_name,
            tool_id,
            tool_input,
            tool_content,
            stdout,
            stderr,
            return_code,
            thinking_content,
        };

        display_messages.push(msg);
        *tree_index += 1;
    }

    display_messages
}

/// Convert a system record (api_error) to a display message
fn convert_system_to_display_message(sys: &SystemRecord, tree_index: &mut u32) -> Option<DisplayMessage> {
    let subtype = sys.subtype.as_deref().unwrap_or("");

    if subtype != "api_error" {
        return None;
    }

    // Build readable summary from error details
    let mut summary = String::new();
    if let Some(error) = &sys.error {
        if let Some(status) = error.get("status").and_then(|v| v.as_u64()) {
            summary.push_str(&format!("HTTP {} ", status));
        }
        if let Some(cause) = error.get("cause") {
            if let Some(code) = cause.get("code").and_then(|v| v.as_str()) {
                summary.push_str(code);
                summary.push(' ');
            }
        }
        // Extract nested error message
        if let Some(err_obj) = error.get("error") {
            if let Some(msg) = err_obj.get("message").and_then(|v| v.as_str()) {
                let truncated = if msg.len() > 100 { &msg[..100] } else { msg };
                summary.push_str(truncated);
                summary.push(' ');
            }
        }
    }
    if let Some(retry) = sys.retry_attempt {
        let max = sys.max_retries.unwrap_or(0);
        summary.push_str(&format!("(retry {}/{})", retry, max));
    }

    let text = summary.trim().to_string();

    let msg = DisplayMessage {
        display_type: DisplayType::Error,
        uuid: sys.uuid.clone(),
        parent_uuid: sys.parent_uuid.clone(),
        timestamp: sys.timestamp.clone(),
        tree_index: *tree_index,
        blocks: vec![ContentBlock::Text { text }],
        tool_name: None,
        tool_id: None,
        tool_input: None,
        tool_content: None,
        stdout: None,
        stderr: None,
        return_code: None,
        thinking_content: None,
    };

    *tree_index += 1;
    Some(msg)
}

/// Parse result containing both messages and stats (single-pass)
pub struct ParseResult {
    pub messages: Vec<DisplayMessage>,
    pub line_count: u32,
    pub message_count: u32,
    pub first_human_message: Option<String>,
    pub type_string: String,
}

/// Parse a JSONL file in a single pass, returning both messages and stats
pub fn parse_jsonl_file_with_stats(path: &Path) -> Result<ParseResult> {
    let file = File::open(path).context("Failed to open JSONL file")?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    let mut tree_index: u32 = 0;
    let mut line_count: u32 = 0;
    let mut first_human_message: Option<String> = None;
    let mut type_string = String::new();

    for (line_num, line) in reader.lines().enumerate() {
        let line = line.context(format!("Failed to read line {}", line_num + 1))?;

        if line.trim().is_empty() {
            continue;
        }

        line_count += 1;

        match parse_jsonl_line(&line) {
            Ok(JsonlLine::Message(raw)) => {
                // Collect first human message
                if first_human_message.is_none() && raw.message.role == "user" {
                    for block in &raw.message.content {
                        if let ContentBlock::Text { text } = block {
                            first_human_message = Some(truncate_string(text, 200));
                            break;
                        }
                    }
                }

                // Build type string per content block
                for block in &raw.message.content {
                    let type_char = match block {
                        ContentBlock::Text { .. } => {
                            if raw.message.role == "user" { 'h' } else { 'a' }
                        }
                        ContentBlock::ToolUse { .. } | ContentBlock::ServerToolUse { .. } => 'c',
                        ContentBlock::ToolResult { .. } => 'r',
                        ContentBlock::Thinking { .. } => 'y',
                        ContentBlock::CodeExecutionResult { .. } => 'y',
                    };
                    type_string.push(type_char);
                }

                let display_messages = convert_to_display_messages(&raw, &mut tree_index);
                messages.extend(display_messages);
            }
            Ok(JsonlLine::System(sys)) => {
                if let Some(msg) = convert_system_to_display_message(&sys, &mut tree_index) {
                    messages.push(msg);
                    type_string.push('e');
                }
            }
            Ok(JsonlLine::Summary(_)) | Ok(JsonlLine::FileHistory(_)) | Ok(JsonlLine::Unknown(_)) => {}
            Err(e) => {
                log::warn!("Failed to parse line {}: {}", line_num + 1, e);
            }
        }
    }

    let message_count = messages.len() as u32;

    Ok(ParseResult {
        messages,
        line_count,
        message_count,
        first_human_message,
        type_string,
    })
}

/// Get line count and message count for a JSONL file
pub fn get_file_stats(path: &Path) -> Result<(u32, u32, Option<String>, String)> {
    let file = File::open(path).context("Failed to open JSONL file")?;
    let reader = BufReader::new(file);
    let mut line_count: u32 = 0;
    let mut message_count: u32 = 0;
    let mut first_human_message: Option<String> = None;
    let mut type_string = String::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        line_count += 1;

        match parse_jsonl_line(&line) {
            Ok(JsonlLine::Message(raw)) => {
                // Get first human message
                if first_human_message.is_none() && raw.message.role == "user" {
                    for block in &raw.message.content {
                        if let ContentBlock::Text { text } = block {
                            // Truncate to ~200 chars, respecting UTF-8 boundaries
                            let preview = truncate_string(text, 200);
                            first_human_message = Some(preview);
                            break;
                        }
                    }
                }

                // Build type string per content block (matching display message expansion)
                for block in &raw.message.content {
                    message_count += 1;
                    let type_char = match block {
                        ContentBlock::Text { .. } => {
                            if raw.message.role == "user" { 'h' } else { 'a' }
                        }
                        ContentBlock::ToolUse { .. } | ContentBlock::ServerToolUse { .. } => 'c',
                        ContentBlock::ToolResult { .. } => 'r',
                        ContentBlock::Thinking { .. } => 'y',
                        ContentBlock::CodeExecutionResult { .. } => 'y',
                    };
                    type_string.push(type_char);
                }
            }
            Ok(JsonlLine::System(sys)) => {
                if sys.subtype.as_deref() == Some("api_error") {
                    message_count += 1;
                    type_string.push('e');
                }
            }
            _ => {}
        }
    }

    Ok((line_count, message_count, first_human_message, type_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_message() {
        let json = r#"{"uuid":"123","parentUuid":null,"timestamp":"2024-01-01T00:00:00Z","type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}"#;

        let result = parse_jsonl_line(json).unwrap();
        match result {
            JsonlLine::Message(msg) => {
                assert_eq!(msg.uuid, "123");
                assert_eq!(msg.message.role, "user");
            }
            _ => panic!("Expected Message"),
        }
    }

    #[test]
    fn test_parse_summary() {
        let json = r#"{"type":"summary","summary":"test","leafUuid":"123","timestamp":"2024-01-01"}"#;

        let result = parse_jsonl_line(json).unwrap();
        match result {
            JsonlLine::Summary(s) => {
                assert_eq!(s.summary, "test");
            }
            _ => panic!("Expected Summary"),
        }
    }
}
