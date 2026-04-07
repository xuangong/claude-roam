//! File system watcher for JSONL files

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Session change event sent to frontend
#[derive(Clone, Serialize)]
pub struct SessionChangeEvent {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "encodedDir")]
    pub encoded_dir: String,
    #[serde(rename = "changeType")]
    pub change_type: String,
    #[serde(rename = "newLineCount")]
    pub new_line_count: Option<u32>,
}

/// File watcher for Claude session files
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
}

impl FileWatcher {
    /// Create a new file watcher
    pub fn new(app: AppHandle) -> Result<Self, notify::Error> {
        let debounce_map: Arc<Mutex<HashMap<PathBuf, Instant>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Use synchronous callback handler to avoid tokio runtime dependency
        let app_clone = app.clone();
        let debounce_map_clone = debounce_map.clone();

        // Create watcher with synchronous callback
        let watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    Self::handle_event_sync(event, &app_clone, &debounce_map_clone);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(200)),
        )?;

        Ok(Self { _watcher: watcher })
    }

    /// Start watching the Claude projects directory
    pub fn watch_claude_dir(&mut self) -> Result<(), notify::Error> {
        let home = dirs::home_dir().expect("Could not find home directory");
        let projects_dir = home.join(".claude").join("projects");

        if projects_dir.exists() {
            self._watcher
                .watch(&projects_dir, RecursiveMode::Recursive)?;
            log::info!("Watching directory: {:?}", projects_dir);
        } else {
            log::warn!(
                "Claude projects directory does not exist: {:?}",
                projects_dir
            );
        }

        Ok(())
    }

    /// Synchronous event handler (runs in watcher callback thread)
    fn handle_event_sync(
        event: Event,
        app: &AppHandle,
        debounce_map: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    ) {
        let change_type = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "deleted",
            _ => return,
        };

        for path in event.paths {
            // Only process .jsonl files
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }

            // Debounce: merge events within 100ms
            {
                let mut map = debounce_map.lock().unwrap();
                let now = Instant::now();

                if let Some(last) = map.get(&path) {
                    if now.duration_since(*last) < Duration::from_millis(100) {
                        continue;
                    }
                }

                map.insert(path.clone(), now);
            }

            // Extract session_id and encoded_dir
            let session_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let encoded_dir = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Get new line count (if file exists)
            let new_line_count = if change_type != "deleted" {
                std::fs::read_to_string(&path)
                    .map(|content| content.lines().count() as u32)
                    .ok()
            } else {
                None
            };

            // Send event to frontend
            let event = SessionChangeEvent {
                session_id,
                encoded_dir,
                change_type: change_type.to_string(),
                new_line_count,
            };

            if let Err(e) = app.emit("session-changed", event) {
                log::error!("Failed to emit session-changed event: {}", e);
            }
        }
    }
}
