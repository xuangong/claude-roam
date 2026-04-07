//! Claude Roam - Tauri 2 Application
//!
//! Session history viewer for Claude Code

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod parser;
mod state;
mod storage;
mod utils;
mod watcher;

use state::{AppDb, WatcherState};
use storage::init_database;
use tauri::Manager;
use watcher::FileWatcher;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

fn main() {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("Starting Claude Roam...");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            log::info!("Setting up application...");

            // Initialize database
            let conn = init_database(&app.handle()).expect("Failed to initialize database");
            app.manage(AppDb::new(conn));

            // Initialize watcher state
            let watcher_state = WatcherState::new();

            // Set Claude directory
            if let Some(home) = dirs::home_dir() {
                let claude_dir = home.join(".claude");
                if claude_dir.exists() {
                    let state_clone = watcher_state.clone();
                    tauri::async_runtime::spawn(async move {
                        state_clone.set_claude_dir(claude_dir).await;
                    });
                }
            }

            app.manage(watcher_state);

            // Initialize file watcher
            match FileWatcher::new(app.handle().clone()) {
                Ok(mut watcher) => {
                    if let Err(e) = watcher.watch_claude_dir() {
                        log::error!("Failed to start file watcher: {}", e);
                    } else {
                        log::info!("File watcher started successfully");
                    }
                    // Store watcher to keep it alive
                    app.manage(std::sync::Mutex::new(Some(watcher)));
                }
                Err(e) => {
                    log::error!("Failed to create file watcher: {}", e);
                }
            }

            // macOS window vibrancy effect
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let materials = [
                        NSVisualEffectMaterial::UnderWindowBackground,
                        NSVisualEffectMaterial::Sidebar,
                    ];
                    for material in materials.iter() {
                        if apply_vibrancy(&window, *material, None, Some(12.0)).is_ok() {
                            log::info!("Applied vibrancy effect: {:?}", material);
                            break;
                        }
                    }
                }
            }

            log::info!("Application setup complete");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Projects & Sessions
            commands::projects::list_projects,
            commands::projects::get_project_sessions,
            commands::sessions::list_sessions,
            commands::sessions::get_session,
            commands::sessions::scan_sessions,
            commands::sessions::export_roam,
            commands::sessions::import_roam,
            // Messages
            commands::messages::get_messages_range,
            commands::messages::get_message_by_uuid,
            commands::messages::get_tree_path,
            // Search
            commands::search::search_messages,
            commands::search::search_tool_calls,
            // Analysis
            commands::analysis::analyze_session,
            // Storage Admin
            commands::storage::storage_list_tables,
            commands::storage::storage_read_table,
            commands::storage::storage_execute_sql,
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
