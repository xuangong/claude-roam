//! Sessions storage operations

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::parser::SessionMeta;

/// Insert or update a session
pub fn upsert_session(conn: &Connection, session: &SessionMeta) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO sessions (
            id, encoded_dir, directory, line_count, message_count,
            first_human_message, last_modified, parsed_at, file_size,
            tree_count, type_string
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            encoded_dir = excluded.encoded_dir,
            directory = excluded.directory,
            line_count = excluded.line_count,
            message_count = excluded.message_count,
            first_human_message = excluded.first_human_message,
            last_modified = excluded.last_modified,
            parsed_at = excluded.parsed_at,
            file_size = excluded.file_size,
            tree_count = excluded.tree_count,
            type_string = excluded.type_string
        "#,
        rusqlite::params![
            session.id,
            session.encoded_dir,
            session.directory,
            session.line_count,
            session.message_count,
            session.first_human_message,
            session.last_modified,
            session.parsed_at,
            session.file_size,
            session.tree_count,
            session.type_string,
        ],
    )
    .context("Failed to upsert session")?;

    Ok(())
}

/// Get all sessions
pub fn get_all_sessions(
    conn: &Connection,
    encoded_dir: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<SessionMeta>> {
    let mut sql = String::from(
        r#"
        SELECT id, encoded_dir, directory, line_count, message_count,
               first_human_message, last_modified, parsed_at, file_size,
               tree_count, type_string
        FROM sessions
        "#,
    );

    if encoded_dir.is_some() {
        sql.push_str(" WHERE encoded_dir = ?1");
    }

    sql.push_str(" ORDER BY last_modified DESC");

    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {}", limit));
    }

    if let Some(offset) = offset {
        sql.push_str(&format!(" OFFSET {}", offset));
    }

    let mut stmt = conn.prepare(&sql)?;

    let rows = if let Some(dir) = encoded_dir {
        stmt.query_map([dir], map_session_row)?
    } else {
        stmt.query_map([], map_session_row)?
    };

    let sessions: Result<Vec<_>, _> = rows.collect();
    Ok(sessions?)
}

/// Get a single session by ID
pub fn get_session(conn: &Connection, session_id: &str) -> Result<Option<SessionMeta>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, encoded_dir, directory, line_count, message_count,
               first_human_message, last_modified, parsed_at, file_size,
               tree_count, type_string
        FROM sessions
        WHERE id = ?1
        "#,
    )?;

    let result = stmt.query_row([session_id], map_session_row).ok();
    Ok(result)
}

/// Delete a session
pub fn delete_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
    Ok(())
}

/// Get sessions that no longer exist on disk
pub fn get_stale_sessions(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id, encoded_dir FROM sessions")?;
    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let encoded_dir: String = row.get(1)?;
        Ok((id, encoded_dir))
    })?;

    let home = dirs::home_dir().context("Could not find home directory")?;
    let mut stale = Vec::new();

    for row in rows {
        let (id, encoded_dir) = row?;
        let path = home
            .join(".claude")
            .join("projects")
            .join(&encoded_dir)
            .join(format!("{}.jsonl", id));

        if !path.exists() {
            stale.push(id);
        }
    }

    Ok(stale)
}

fn map_session_row(row: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
    let last_modified: i64 = row.get(6)?;
    // Convert Unix timestamp to ISO 8601 string
    let timestamp_str = chrono::DateTime::from_timestamp(last_modified, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string());

    Ok(SessionMeta {
        id: row.get(0)?,
        encoded_dir: row.get(1)?,
        directory: row.get(2)?,
        line_count: row.get(3)?,
        message_count: row.get(4)?,
        first_human_message: row.get(5)?,
        last_modified,
        parsed_at: row.get(7)?,
        file_size: row.get(8)?,
        tree_count: row.get(9)?,
        type_string: row.get(10)?,
        created_at: timestamp_str.clone(),
        updated_at: timestamp_str,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations::run_migrations;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn test_upsert_session() {
        let conn = setup_db();

        let session = SessionMeta {
            id: "test-session".to_string(),
            encoded_dir: "test-dir".to_string(),
            directory: "/test/path".to_string(),
            line_count: 100,
            message_count: 50,
            first_human_message: Some("Hello".to_string()),
            last_modified: 1234567890,
            parsed_at: Some(1234567891),
            file_size: 1024,
            tree_count: 1,
            type_string: Some("HAHA".to_string()),
            created_at: None,
            updated_at: None,
        };

        upsert_session(&conn, &session).unwrap();

        let result = get_session(&conn, "test-session").unwrap().unwrap();
        assert_eq!(result.id, "test-session");
        assert_eq!(result.line_count, 100);
    }

    #[test]
    fn test_get_all_sessions() {
        let conn = setup_db();

        // Insert two sessions
        let session1 = SessionMeta {
            id: "session-1".to_string(),
            encoded_dir: "dir-1".to_string(),
            directory: "/path/1".to_string(),
            line_count: 100,
            message_count: 50,
            first_human_message: None,
            last_modified: 1000,
            parsed_at: None,
            file_size: 1024,
            tree_count: 1,
            type_string: None,
            created_at: None,
            updated_at: None,
        };

        let session2 = SessionMeta {
            id: "session-2".to_string(),
            encoded_dir: "dir-2".to_string(),
            directory: "/path/2".to_string(),
            line_count: 200,
            message_count: 100,
            first_human_message: None,
            last_modified: 2000,
            parsed_at: None,
            file_size: 2048,
            tree_count: 1,
            type_string: None,
            created_at: None,
            updated_at: None,
        };

        upsert_session(&conn, &session1).unwrap();
        upsert_session(&conn, &session2).unwrap();

        let sessions = get_all_sessions(&conn, None, None, None).unwrap();
        assert_eq!(sessions.len(), 2);

        // Should be ordered by last_modified DESC
        assert_eq!(sessions[0].id, "session-2");
    }
}
