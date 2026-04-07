//! Application database state

use rusqlite::Connection;
use std::sync::Mutex;

/// Database connection state
/// Uses Mutex for thread-safe access
pub struct AppDb(pub Mutex<Connection>);

impl AppDb {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }
}
