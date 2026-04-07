//! Project listing commands

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use tauri::State;

use crate::state::AppDb;
use crate::storage::sessions as session_storage;
use crate::parser::SessionMeta;

/// Project info with session count
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    #[serde(rename = "encodedDir")]
    pub encoded_dir: String,
    pub directory: String,
    #[serde(rename = "sessionCount")]
    pub session_count: u32,
    #[serde(rename = "lastModified")]
    pub last_modified: i64,
}

/// List all projects (encoded directories)
#[tauri::command]
pub async fn list_projects(db: State<'_, AppDb>) -> Result<Vec<ProjectInfo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Get all sessions
    let sessions = session_storage::get_all_sessions(&conn, None, None, None)
        .map_err(|e| e.to_string())?;

    // Group by encoded_dir
    let mut projects: HashMap<String, ProjectInfo> = HashMap::new();

    for session in sessions {
        let entry = projects
            .entry(session.encoded_dir.clone())
            .or_insert(ProjectInfo {
                encoded_dir: session.encoded_dir.clone(),
                directory: session.directory.clone(),
                session_count: 0,
                last_modified: session.last_modified,
            });

        entry.session_count += 1;
        if session.last_modified > entry.last_modified {
            entry.last_modified = session.last_modified;
        }
    }

    let mut result: Vec<_> = projects.into_values().collect();
    result.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    Ok(result)
}

/// Get sessions for a specific project
#[tauri::command]
pub async fn get_project_sessions(
    db: State<'_, AppDb>,
    encoded_dir: String,
) -> Result<Vec<SessionMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    session_storage::get_all_sessions(&conn, Some(&encoded_dir), None, None)
        .map_err(|e| e.to_string())
}

/// Decode a project directory name
fn decode_project_dir(encoded: &str) -> String {
    // URL decode and handle special encoding
    urlencoding::decode(encoded)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| encoded.to_string())
}

/// Get project directories from file system
pub fn scan_project_dirs() -> Result<Vec<(String, String)>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();

    let entries = fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let decoded = decode_project_dir(name);
                projects.push((name.to_string(), decoded));
            }
        }
    }

    Ok(projects)
}
