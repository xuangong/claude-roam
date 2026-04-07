//! Database migrations

use anyhow::{Context, Result};
use rusqlite::Connection;

/// Current migration version
const CURRENT_VERSION: i32 = 1;

/// Run all migrations
pub fn run_migrations(conn: &Connection) -> Result<()> {
    // Get current version
    let version = get_version(conn)?;

    log::info!("Database version: {}, current: {}", version, CURRENT_VERSION);

    if version < 1 {
        migrate_v1(conn)?;
    }

    // Update version
    set_version(conn, CURRENT_VERSION)?;

    Ok(())
}

fn get_version(conn: &Connection) -> Result<i32> {
    let result = conn.query_row("PRAGMA user_version", [], |row| row.get(0));
    Ok(result.unwrap_or(0))
}

fn set_version(conn: &Connection, version: i32) -> Result<()> {
    conn.execute(&format!("PRAGMA user_version = {}", version), [])?;
    Ok(())
}

/// Migration v1: Initial schema
fn migrate_v1(conn: &Connection) -> Result<()> {
    log::info!("Running migration v1...");

    conn.execute_batch(
        r#"
        -- Sessions metadata table
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            encoded_dir TEXT NOT NULL,
            directory TEXT NOT NULL,
            line_count INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            first_human_message TEXT,
            last_modified INTEGER NOT NULL,
            parsed_at INTEGER,
            file_size INTEGER DEFAULT 0,
            tree_count INTEGER DEFAULT 1,
            type_string TEXT
        );

        -- Message chunks storage table (100 messages per chunk)
        CREATE TABLE IF NOT EXISTS message_chunks (
            session_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            messages TEXT NOT NULL,
            PRIMARY KEY (session_id, chunk_index),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        -- Message index for quick lookup
        CREATE TABLE IF NOT EXISTS message_index (
            session_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            parent_uuid TEXT,
            tree_index INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            offset_in_chunk INTEGER NOT NULL,
            display_type TEXT NOT NULL,
            timestamp TEXT,
            PRIMARY KEY (session_id, uuid),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        -- Full-text search virtual table
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            session_id,
            uuid,
            content,
            tool_name,
            tokenize='unicode61'
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_sessions_encoded_dir ON sessions(encoded_dir);
        CREATE INDEX IF NOT EXISTS idx_sessions_last_modified ON sessions(last_modified DESC);
        CREATE INDEX IF NOT EXISTS idx_message_index_tree ON message_index(session_id, tree_index);
        CREATE INDEX IF NOT EXISTS idx_message_index_parent ON message_index(session_id, parent_uuid);
        "#,
    )
    .context("Failed to run migration v1")?;

    log::info!("Migration v1 completed");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        // Verify tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"message_chunks".to_string()));
        assert!(tables.contains(&"message_index".to_string()));
    }
}
