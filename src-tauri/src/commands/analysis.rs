//! Analysis commands

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use tauri::State;

use crate::parser::{
    DisplayMessage, DisplayType, SessionAnalysis, TimeSpan, ToolCallStat, ToolUsageStat, TokenUsage,
};
use crate::state::AppDb;
use crate::storage::{messages as message_storage, sessions as session_storage};

/// Analyze a session
#[tauri::command]
pub async fn analyze_session(
    db: State<'_, AppDb>,
    session_id: String,
) -> Result<SessionAnalysis, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Get session metadata
    let session = session_storage::get_session(&conn, &session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;

    // Get all messages
    let messages =
        message_storage::get_messages_range(&conn, &session_id, 0, session.message_count)
            .map_err(|e| e.to_string())?;

    // Calculate statistics
    let total_messages = messages.len() as u32;
    let human_messages = messages
        .iter()
        .filter(|m| m.display_type == DisplayType::Human)
        .count() as u32;
    let assistant_messages = messages
        .iter()
        .filter(|m| m.display_type == DisplayType::Assistant)
        .count() as u32;

    // Analyze tool calls
    let tool_calls = analyze_tool_calls(&messages);

    // Get top tools by usage
    let mut tool_counts: HashMap<String, u32> = HashMap::new();
    for msg in &messages {
        if msg.display_type == DisplayType::ToolUse {
            if let Some(name) = &msg.tool_name {
                *tool_counts.entry(name.clone()).or_insert(0) += 1;
            }
        }
    }

    let mut top_tools: Vec<_> = tool_counts
        .into_iter()
        .map(|(name, count)| ToolUsageStat { name, count })
        .collect();
    top_tools.sort_by(|a, b| b.count.cmp(&a.count));
    top_tools.truncate(10);

    // Calculate time span
    let time_span = calculate_time_span(&messages);

    // Calculate token usage from JSONL file
    let token_usage = calculate_token_usage(&session.id, &session.encoded_dir);

    Ok(SessionAnalysis {
        total_messages,
        human_messages,
        assistant_messages,
        tool_calls,
        tree_count: session.tree_count,
        time_span,
        top_tools_by_usage: top_tools,
        token_usage,
    })
}

fn analyze_tool_calls(messages: &[DisplayMessage]) -> Vec<ToolCallStat> {
    let mut stats: HashMap<String, ToolCallStat> = HashMap::new();

    // Collect tool uses and their results
    let mut tool_uses: HashMap<String, String> = HashMap::new(); // tool_id -> tool_name

    for msg in messages {
        match msg.display_type {
            DisplayType::ToolUse => {
                if let (Some(name), Some(id)) = (&msg.tool_name, &msg.tool_id) {
                    tool_uses.insert(id.clone(), name.clone());

                    let stat = stats.entry(name.clone()).or_insert(ToolCallStat {
                        tool_name: name.clone(),
                        call_count: 0,
                        success_count: 0,
                        error_count: 0,
                    });
                    stat.call_count += 1;
                }
            }
            DisplayType::ToolResult => {
                if let Some(id) = &msg.tool_id {
                    if let Some(name) = tool_uses.get(id) {
                        if let Some(stat) = stats.get_mut(name) {
                            // Check if result contains error
                            let has_error = check_tool_error(msg);
                            if has_error {
                                stat.error_count += 1;
                            } else {
                                stat.success_count += 1;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut result: Vec<_> = stats.into_values().collect();
    result.sort_by(|a, b| b.call_count.cmp(&a.call_count));
    result
}

fn check_tool_error(msg: &DisplayMessage) -> bool {
    if let Some(content) = &msg.tool_content {
        match content {
            crate::parser::ToolResultContent::Text(text) => {
                text.to_lowercase().contains("error")
                    || text.to_lowercase().contains("failed")
                    || text.to_lowercase().contains("exception")
            }
            crate::parser::ToolResultContent::Blocks(_) => false,
        }
    } else {
        false
    }
}

fn calculate_time_span(messages: &[DisplayMessage]) -> Option<TimeSpan> {
    let timestamps: Vec<_> = messages
        .iter()
        .filter_map(|m| m.timestamp.as_ref())
        .collect();

    if timestamps.is_empty() {
        return None;
    }

    let start = timestamps.first()?.to_string();
    let end = timestamps.last()?.to_string();

    // Try to parse timestamps and calculate duration
    let duration_minutes = if let (Ok(start_dt), Ok(end_dt)) = (
        chrono::DateTime::parse_from_rfc3339(&start),
        chrono::DateTime::parse_from_rfc3339(&end),
    ) {
        (end_dt - start_dt).num_minutes()
    } else {
        0
    };

    Some(TimeSpan {
        start,
        end,
        duration_minutes,
    })
}

/// Calculate token usage by reading the JSONL file directly
fn calculate_token_usage(session_id: &str, encoded_dir: &str) -> Option<TokenUsage> {
    let home = dirs::home_dir()?;
    let path = home
        .join(".claude")
        .join("projects")
        .join(encoded_dir)
        .join(format!("{}.jsonl", session_id));

    let file = std::fs::File::open(&path).ok()?;
    let reader = BufReader::new(file);

    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut cache_creation_tokens: u64 = 0;
    let mut found_any = false;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if !line.contains("\"usage\"") {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(usage) = value.get("message").and_then(|m| m.get("usage")) {
            if let Some(v) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                input_tokens += v;
                found_any = true;
            }
            if let Some(v) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                output_tokens += v;
            }
            if let Some(v) = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
                cache_read_tokens += v;
            }
            if let Some(v) = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()) {
                cache_creation_tokens += v;
            }
        }
    }

    if found_any {
        Some(TokenUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        })
    } else {
        None
    }
}
