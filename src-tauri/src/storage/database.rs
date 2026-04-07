//! Database initialization and connection management

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::PathBuf;
use tauri::AppHandle;

use super::migrations::run_migrations;

/// Get the database path
pub fn get_db_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    let db_dir = home.join(".claude-roam");

    // Create directory if it doesn't exist
    std::fs::create_dir_all(&db_dir).context("Failed to create database directory")?;

    Ok(db_dir.join("claude-roam.db"))
}

/// Initialize the database connection
pub fn init_database(_app: &AppHandle) -> Result<Connection> {
    let db_path = get_db_path()?;

    log::info!("Initializing database at: {:?}", db_path);

    let conn = Connection::open(&db_path).context("Failed to open database")?;

    // Enable WAL mode for better concurrent performance
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

    // Run migrations
    run_migrations(&conn)?;

    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_db_path() {
        let path = get_db_path().unwrap();
        assert!(path.ends_with("claude-roam.db"));
    }
}
