//! Messages storage operations

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::parser::{DisplayMessage, DisplayType};

const CHUNK_SIZE: usize = 100;

/// Store messages for a session in chunks (using transaction for performance)
pub fn store_messages(conn: &Connection, session_id: &str, messages: &[DisplayMessage]) -> Result<()> {
    conn.execute_batch("BEGIN")?;

    let result = store_messages_inner(conn, session_id, messages);

    if result.is_ok() {
        conn.execute_batch("COMMIT")?;
    } else {
        conn.execute_batch("ROLLBACK").ok();
    }

    result
}

fn store_messages_inner(conn: &Connection, session_id: &str, messages: &[DisplayMessage]) -> Result<()> {
    // Clear existing data
    conn.execute(
        "DELETE FROM message_chunks WHERE session_id = ?1",
        [session_id],
    )?;
    conn.execute(
        "DELETE FROM message_index WHERE session_id = ?1",
        [session_id],
    )?;
    conn.execute(
        "DELETE FROM messages_fts WHERE session_id = ?1",
        [session_id],
    )?;

    // Store in chunks
    for (chunk_index, chunk) in messages.chunks(CHUNK_SIZE).enumerate() {
        let start_line = chunk_index * CHUNK_SIZE;
        let end_line = start_line + chunk.len() - 1;

        let messages_json = serde_json::to_string(chunk)?;

        conn.execute(
            r#"
            INSERT INTO message_chunks (session_id, chunk_index, start_line, end_line, messages)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            rusqlite::params![session_id, chunk_index as i64, start_line as i64, end_line as i64, messages_json],
        )?;

        // Create index entries for each message in chunk
        // Use INSERT OR REPLACE to handle duplicate uuids in JSONL files
        for (offset, msg) in chunk.iter().enumerate() {
            conn.execute(
                r#"
                INSERT OR REPLACE INTO message_index (
                    session_id, uuid, parent_uuid, tree_index, chunk_index,
                    offset_in_chunk, display_type, timestamp
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                rusqlite::params![
                    session_id,
                    msg.uuid,
                    msg.parent_uuid,
                    msg.tree_index,
                    chunk_index as i64,
                    offset as i64,
                    format!("{:?}", msg.display_type),
                    msg.timestamp,
                ],
            )?;

            // Index for FTS
            let content = extract_text_content(msg);
            if !content.is_empty() {
                conn.execute(
                    r#"
                    INSERT INTO messages_fts (session_id, uuid, content, tool_name)
                    VALUES (?1, ?2, ?3, ?4)
                    "#,
                    rusqlite::params![session_id, msg.uuid, content, msg.tool_name],
                )?;
            }
        }
    }

    Ok(())
}

/// Get messages in a range
pub fn get_messages_range(
    conn: &Connection,
    session_id: &str,
    start_index: u32,
    end_index: u32,
) -> Result<Vec<DisplayMessage>> {
    let start_chunk = start_index as usize / CHUNK_SIZE;
    let end_chunk = end_index as usize / CHUNK_SIZE;

    let mut messages = Vec::new();

    for chunk_index in start_chunk..=end_chunk {
        let chunk_data: Option<String> = conn
            .query_row(
                "SELECT messages FROM message_chunks WHERE session_id = ?1 AND chunk_index = ?2",
                rusqlite::params![session_id, chunk_index as i64],
                |row| row.get(0),
            )
            .ok();

        if let Some(json) = chunk_data {
            let chunk_messages: Vec<DisplayMessage> =
                serde_json::from_str(&json).context("Failed to parse chunk messages")?;

            for msg in chunk_messages {
                if msg.tree_index >= start_index && msg.tree_index <= end_index {
                    messages.push(msg);
                }
            }
        }
    }

    Ok(messages)
}

/// Get a single message by UUID
pub fn get_message_by_uuid(
    conn: &Connection,
    session_id: &str,
    uuid: &str,
) -> Result<Option<DisplayMessage>> {
    // First find the chunk
    let index_row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT chunk_index, offset_in_chunk FROM message_index WHERE session_id = ?1 AND uuid = ?2",
            rusqlite::params![session_id, uuid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((chunk_index, offset)) = index_row {
        let chunk_data: String = conn.query_row(
            "SELECT messages FROM message_chunks WHERE session_id = ?1 AND chunk_index = ?2",
            rusqlite::params![session_id, chunk_index],
            |row| row.get(0),
        )?;

        let chunk_messages: Vec<DisplayMessage> = serde_json::from_str(&chunk_data)?;
        return Ok(chunk_messages.into_iter().nth(offset as usize));
    }

    Ok(None)
}

/// Search messages using FTS
pub fn search_messages(
    conn: &Connection,
    session_id: &str,
    query: &str,
    limit: Option<u32>,
) -> Result<Vec<crate::parser::SearchResult>> {
    let limit = limit.unwrap_or(50);

    let mut stmt = conn.prepare(
        r#"
        SELECT uuid, content, tool_name, rank
        FROM messages_fts
        WHERE session_id = ?1 AND messages_fts MATCH ?2
        ORDER BY rank
        LIMIT ?3
        "#,
    )?;

    let rows = stmt.query_map(rusqlite::params![session_id, query, limit], |row| {
        let uuid: String = row.get(0)?;
        let content: String = row.get(1)?;
        let _tool_name: Option<String> = row.get(2)?;
        let rank: f32 = row.get(3)?;

        // Get tree_index and display_type from message_index
        Ok((uuid, content, rank))
    })?;

    let mut results = Vec::new();

    for row in rows {
        let (uuid, content, rank) = row?;

        // Get additional info from message_index
        let index_info: Option<(i64, String)> = conn
            .query_row(
                "SELECT tree_index, display_type FROM message_index WHERE session_id = ?1 AND uuid = ?2",
                rusqlite::params![session_id, &uuid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((tree_index, display_type)) = index_info {
            // Create snippet (first 200 chars)
            let snippet = if content.len() > 200 {
                format!("{}...", &content[..200])
            } else {
                content
            };

            results.push(crate::parser::SearchResult {
                uuid,
                tree_index: tree_index as u32,
                display_type,
                snippet,
                score: -rank, // FTS5 rank is negative
            });
        }
    }

    Ok(results)
}

/// Search tool calls
pub fn search_tool_calls(
    conn: &Connection,
    session_id: &str,
    tool_name: Option<&str>,
) -> Result<Vec<crate::parser::ToolCallResult>> {
    let mut results = Vec::new();

    // Get all message chunks
    let mut stmt = conn.prepare(
        "SELECT messages FROM message_chunks WHERE session_id = ?1 ORDER BY chunk_index",
    )?;

    let chunks = stmt.query_map([session_id], |row| {
        let json: String = row.get(0)?;
        Ok(json)
    })?;

    for chunk_result in chunks {
        let chunk_json = chunk_result?;
        let messages: Vec<DisplayMessage> = serde_json::from_str(&chunk_json)?;

        for msg in messages {
            if msg.display_type == DisplayType::ToolUse {
                if let (Some(name), Some(id)) = (&msg.tool_name, &msg.tool_id) {
                    // Filter by tool name if provided
                    if let Some(filter_name) = tool_name {
                        if name != filter_name {
                            continue;
                        }
                    }

                    results.push(crate::parser::ToolCallResult {
                        uuid: msg.uuid,
                        tree_index: msg.tree_index,
                        tool_name: name.clone(),
                        tool_id: id.clone(),
                        input: msg.tool_input.clone().unwrap_or(serde_json::Value::Null),
                    });
                }
            }
        }
    }

    Ok(results)
}

/// Extract text content from a message for FTS indexing
fn extract_text_content(msg: &DisplayMessage) -> String {
    let mut content = String::new();

    for block in &msg.blocks {
        match block {
            crate::parser::ContentBlock::Text { text } => {
                content.push_str(text);
                content.push(' ');
            }
            crate::parser::ContentBlock::Thinking { thinking } => {
                content.push_str(thinking);
                content.push(' ');
            }
            crate::parser::ContentBlock::ToolResult { content: result, .. } => {
                if let crate::parser::ToolResultContent::Text(text) = result {
                    content.push_str(text);
                    content.push(' ');
                }
            }
            crate::parser::ContentBlock::CodeExecutionResult { stdout, stderr, .. } => {
                if let Some(s) = stdout {
                    content.push_str(s);
                    content.push(' ');
                }
                if let Some(e) = stderr {
                    content.push_str(e);
                    content.push(' ');
                }
            }
            _ => {}
        }
    }

    content.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::ContentBlock;
    use crate::storage::migrations::run_migrations;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn test_store_and_get_messages() {
        let conn = setup_db();

        let messages = vec![
            DisplayMessage {
                display_type: DisplayType::Human,
                uuid: "msg-1".to_string(),
                parent_uuid: None,
                timestamp: Some("2024-01-01".to_string()),
                tree_index: 0,
                blocks: vec![ContentBlock::Text {
                    text: "Hello".to_string(),
                }],
                tool_name: None,
                tool_id: None,
                tool_input: None,
                tool_content: None,
                stdout: None,
                stderr: None,
                return_code: None,
                thinking_content: None,
            },
            DisplayMessage {
                display_type: DisplayType::Assistant,
                uuid: "msg-2".to_string(),
                parent_uuid: Some("msg-1".to_string()),
                timestamp: Some("2024-01-01".to_string()),
                tree_index: 1,
                blocks: vec![ContentBlock::Text {
                    text: "Hi there!".to_string(),
                }],
                tool_name: None,
                tool_id: None,
                tool_input: None,
                tool_content: None,
                stdout: None,
                stderr: None,
                return_code: None,
                thinking_content: None,
            },
        ];

        store_messages(&conn, "test-session", &messages).unwrap();

        let result = get_messages_range(&conn, "test-session", 0, 1).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].uuid, "msg-1");
        assert_eq!(result[1].uuid, "msg-2");
    }

    #[test]
    fn test_get_message_by_uuid() {
        let conn = setup_db();

        let messages = vec![DisplayMessage {
            display_type: DisplayType::Human,
            uuid: "test-uuid".to_string(),
            parent_uuid: None,
            timestamp: None,
            tree_index: 0,
            blocks: vec![ContentBlock::Text {
                text: "Test".to_string(),
            }],
            tool_name: None,
            tool_id: None,
            tool_input: None,
            tool_content: None,
            stdout: None,
            stderr: None,
            return_code: None,
            thinking_content: None,
        }];

        store_messages(&conn, "test-session", &messages).unwrap();

        let result = get_message_by_uuid(&conn, "test-session", "test-uuid")
            .unwrap()
            .unwrap();
        assert_eq!(result.uuid, "test-uuid");
    }
}
