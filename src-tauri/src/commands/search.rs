//! Search commands

use tauri::State;

use crate::parser::{SearchResult, ToolCallResult};
use crate::state::AppDb;
use crate::storage::messages as message_storage;

/// Search messages using full-text search
#[tauri::command]
pub async fn search_messages(
    db: State<'_, AppDb>,
    session_id: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchResult>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    message_storage::search_messages(&conn, &session_id, &query, limit)
        .map_err(|e| e.to_string())
}

/// Search tool calls
#[tauri::command]
pub async fn search_tool_calls(
    db: State<'_, AppDb>,
    session_id: String,
    tool_name: Option<String>,
) -> Result<Vec<ToolCallResult>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    message_storage::search_tool_calls(&conn, &session_id, tool_name.as_deref())
        .map_err(|e| e.to_string())
}
