//! Claude Roam - Session history viewer for Claude Code
//!
//! This module provides the Rust backend for the Tauri 2 application.

pub mod commands;
pub mod parser;
pub mod state;
pub mod storage;
pub mod watcher;
pub mod utils;

pub use state::{AppDb, WatcherState};
pub use storage::init_database;
