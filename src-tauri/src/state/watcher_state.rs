//! File watcher state management

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// File watcher state manager
#[derive(Default, Clone)]
pub struct WatcherState {
    /// Active session watchers
    active_watchers: Arc<RwLock<HashMap<String, PathBuf>>>,
    /// Claude directory path
    claude_dir: Arc<RwLock<Option<PathBuf>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn set_claude_dir(&self, claude_dir: PathBuf) {
        let mut dir = self.claude_dir.write().await;
        *dir = Some(claude_dir);
    }

    pub async fn get_claude_dir(&self) -> Option<PathBuf> {
        let dir = self.claude_dir.read().await;
        dir.clone()
    }

    pub async fn register_watcher(&self, session_id: String, path: PathBuf) {
        let mut watchers = self.active_watchers.write().await;
        watchers.insert(session_id, path);
    }

    pub async fn unregister_watcher(&self, session_id: &str) {
        let mut watchers = self.active_watchers.write().await;
        watchers.remove(session_id);
    }

    pub async fn active_count(&self) -> usize {
        let watchers = self.active_watchers.read().await;
        watchers.len()
    }

    pub async fn get_all_watchers(&self) -> HashMap<String, PathBuf> {
        let watchers = self.active_watchers.read().await;
        watchers.clone()
    }
}
