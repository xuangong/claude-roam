//! Session commands

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::State;
use walkdir::WalkDir;

use crate::parser::{parse_jsonl_file_with_stats, ScanResult, SessionMeta};
use crate::state::AppDb;
use crate::storage::{messages as message_storage, sessions as session_storage};

/// List all sessions
#[tauri::command]
pub async fn list_sessions(
    db: State<'_, AppDb>,
    encoded_dir: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<SessionMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    session_storage::get_all_sessions(&conn, encoded_dir.as_deref(), limit, offset)
        .map_err(|e| e.to_string())
}

/// Get a single session by ID
#[tauri::command]
pub async fn get_session(
    db: State<'_, AppDb>,
    session_id: String,
) -> Result<Option<SessionMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    session_storage::get_session(&conn, &session_id).map_err(|e| e.to_string())
}

/// Scan the file system for sessions and update the database
#[tauri::command]
pub async fn scan_sessions(
    db: State<'_, AppDb>,
    force_reparse: Option<bool>,
) -> Result<ScanResult, String> {
    let start = Instant::now();
    let force = force_reparse.unwrap_or(false);

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(ScanResult {
            total_sessions: 0,
            new_sessions: 0,
            updated_sessions: 0,
            deleted_sessions: 0,
            duration_ms: start.elapsed().as_millis() as u64,
        });
    }

    let mut total_sessions = 0;
    let mut new_sessions = 0;
    let mut updated_sessions = 0;

    // Walk through all JSONL files
    for entry in WalkDir::new(&projects_dir)
        .min_depth(2)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }

        // Extract session ID and encoded dir
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Invalid file name")?
            .to_string();

        let encoded_dir = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .ok_or("Invalid directory structure")?
            .to_string();

        // Decode directory name
        let directory = urlencoding::decode(&encoded_dir)
            .map(|s| s.to_string())
            .unwrap_or_else(|_| encoded_dir.clone());

        // Get file metadata
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        let file_size = metadata.len();
        let last_modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        total_sessions += 1;

        // Check if we need to parse (short lock)
        let existing = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            session_storage::get_session(&conn, &session_id).map_err(|e| e.to_string())?
        };

        let needs_parse = force
            || existing.is_none()
            || existing.as_ref().map(|s| s.last_modified < last_modified).unwrap_or(true);

        if needs_parse {
            // Parse outside the lock (most expensive part)
            let parse_result = parse_jsonl_file_with_stats(path).map_err(|e| e.to_string())?;
            let tree_count = count_trees(&parse_result.messages);

            // Create session metadata
            let now = chrono::Utc::now();
            let timestamp_str = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();

            let session = SessionMeta {
                id: session_id.clone(),
                encoded_dir: encoded_dir.clone(),
                directory,
                line_count: parse_result.line_count,
                message_count: parse_result.message_count,
                first_human_message: parse_result.first_human_message,
                last_modified,
                parsed_at: Some(now.timestamp()),
                file_size,
                tree_count,
                type_string: Some(parse_result.type_string),
                created_at: if existing.is_none() {
                    Some(timestamp_str.clone())
                } else {
                    existing.as_ref().and_then(|s| s.created_at.clone())
                },
                updated_at: Some(timestamp_str),
            };

            // Store in DB (lock only for writes)
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            session_storage::upsert_session(&conn, &session).map_err(|e| e.to_string())?;
            message_storage::store_messages(&conn, &session_id, &parse_result.messages).map_err(|e| e.to_string())?;
            drop(conn);

            if existing.is_none() {
                new_sessions += 1;
            } else {
                updated_sessions += 1;
            }
        }
    }

    // Clean up deleted sessions
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let stale_sessions = session_storage::get_stale_sessions(&conn).map_err(|e| e.to_string())?;
    let deleted_sessions = stale_sessions.len() as u32;

    for session_id in stale_sessions {
        session_storage::delete_session(&conn, &session_id).map_err(|e| e.to_string())?;
    }

    Ok(ScanResult {
        total_sessions,
        new_sessions,
        updated_sessions,
        deleted_sessions,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Count unique conversation trees
fn count_trees(messages: &[crate::parser::DisplayMessage]) -> u32 {
    // A tree starts when parent_uuid is None
    messages
        .iter()
        .filter(|m| m.parent_uuid.is_none())
        .count() as u32
}

// ============ Roam File Import/Export ============

/// Roam file bundle format (compatible with CLI)
#[derive(Debug, Serialize, Deserialize)]
struct RoamBundle {
    version: u32,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    source: RoamSource,
    sessions: Vec<RoamSession>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RoamSource {
    #[serde(rename = "machineId", skip_serializing_if = "Option::is_none")]
    machine_id: Option<String>,
    #[serde(rename = "machineName")]
    machine_name: String,
    #[serde(rename = "originalPath")]
    original_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RoamSession {
    id: String,
    #[serde(rename = "lineCount")]
    line_count: u32,
    #[serde(rename = "modifiedAt", skip_serializing_if = "Option::is_none")]
    modified_at: Option<String>,
    data: String,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    imported: u32,
    skipped: u32,
    total: u32,
    source: String,
}

/// Export selected sessions to a .roam file
#[tauri::command]
pub async fn export_roam(
    db: State<'_, AppDb>,
    session_ids: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut sessions_data = Vec::new();

    for session_id in &session_ids {
        let session = session_storage::get_session(&conn, session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Session not found: {}", session_id))?;

        // Find the JSONL file
        let jsonl_path = projects_dir
            .join(&session.encoded_dir)
            .join(format!("{}.jsonl", session_id));

        let data = if jsonl_path.exists() {
            fs::read_to_string(&jsonl_path).map_err(|e| e.to_string())?
        } else {
            return Err(format!("JSONL file not found for session: {}", session_id));
        };

        sessions_data.push(RoamSession {
            id: session_id.clone(),
            line_count: session.line_count,
            modified_at: session.updated_at.clone(),
            data,
        });
    }

    // Get machine name
    let machine_name = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    // Determine directory from first session
    let first_session = session_storage::get_session(&conn, &session_ids[0])
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;

    let bundle = RoamBundle {
        version: 2,
        exported_at: chrono::Utc::now().to_rfc3339(),
        source: RoamSource {
            machine_id: None,
            machine_name: machine_name.clone(),
            original_path: first_session.directory.clone(),
        },
        sessions: sessions_data,
    };

    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&output_path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

    Ok(format!("Exported {} session(s) to {}", session_ids.len(), output_path))
}

/// Import a .roam file
#[tauri::command]
pub async fn import_roam(
    db: State<'_, AppDb>,
    file_path: String,
) -> Result<ImportResult, String> {
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let bundle: RoamBundle = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid .roam file: {}", e))?;

    if bundle.version != 1 && bundle.version != 2 {
        return Err(format!("Unsupported .roam version: {}", bundle.version));
    }

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    // Determine target directory from source
    let encoded_dir = urlencoding::encode(&bundle.source.original_path).to_string();
    let target_dir = projects_dir.join(&encoded_dir);

    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }

    let mut imported = 0u32;
    let mut skipped = 0u32;
    let total = bundle.sessions.len() as u32;

    for session in &bundle.sessions {
        let target_file = target_dir.join(format!("{}.jsonl", session.id));

        if target_file.exists() {
            skipped += 1;
            continue;
        }

        // Write the JSONL file
        fs::write(&target_file, &session.data).map_err(|e| e.to_string())?;

        // Parse and store in database
        let path = PathBuf::from(&target_file);
        match parse_jsonl_file_with_stats(&path) {
            Ok(parse_result) => {
                let tree_count = count_trees(&parse_result.messages);
                let now = chrono::Utc::now();
                let timestamp_str = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();

                let metadata = fs::metadata(&target_file).ok();
                let file_size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let last_modified = metadata
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let session_meta = SessionMeta {
                    id: session.id.clone(),
                    encoded_dir: encoded_dir.clone(),
                    directory: bundle.source.original_path.clone(),
                    line_count: parse_result.line_count,
                    message_count: parse_result.message_count,
                    first_human_message: parse_result.first_human_message,
                    last_modified,
                    parsed_at: Some(now.timestamp()),
                    file_size,
                    tree_count,
                    type_string: Some(parse_result.type_string),
                    created_at: Some(timestamp_str.clone()),
                    updated_at: Some(timestamp_str),
                };

                let conn = db.0.lock().map_err(|e| e.to_string())?;
                session_storage::upsert_session(&conn, &session_meta).map_err(|e| e.to_string())?;
                message_storage::store_messages(&conn, &session.id, &parse_result.messages).map_err(|e| e.to_string())?;
            }
            _ => {
                log::warn!("Failed to parse imported session: {}", session.id);
            }
        }

        imported += 1;
    }

    let source = format!("{}:{}", bundle.source.machine_name, bundle.source.original_path);
    Ok(ImportResult { imported, skipped, total, source })
}
