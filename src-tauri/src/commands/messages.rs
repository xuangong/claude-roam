//! Message commands

use tauri::State;

use crate::parser::DisplayMessage;
use crate::state::AppDb;
use crate::storage::messages as message_storage;

/// Get messages in a range (for virtual scrolling)
#[tauri::command]
pub async fn get_messages_range(
    db: State<'_, AppDb>,
    session_id: String,
    start_index: u32,
    end_index: u32,
) -> Result<Vec<DisplayMessage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    message_storage::get_messages_range(&conn, &session_id, start_index, end_index)
        .map_err(|e| e.to_string())
}

/// Get a single message by UUID
#[tauri::command]
pub async fn get_message_by_uuid(
    db: State<'_, AppDb>,
    session_id: String,
    uuid: String,
) -> Result<Option<DisplayMessage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    message_storage::get_message_by_uuid(&conn, &session_id, &uuid).map_err(|e| e.to_string())
}

/// Get tree path from root to a message
#[tauri::command]
pub async fn get_tree_path(
    db: State<'_, AppDb>,
    session_id: String,
    uuid: String,
) -> Result<Vec<DisplayMessage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut path = Vec::new();
    let mut current_uuid = Some(uuid);

    while let Some(uuid) = current_uuid {
        if let Some(msg) = message_storage::get_message_by_uuid(&conn, &session_id, &uuid)
            .map_err(|e| e.to_string())?
        {
            current_uuid = msg.parent_uuid.clone();
            path.push(msg);
        } else {
            break;
        }
    }

    // Reverse to get path from root to target
    path.reverse();

    Ok(path)
}
