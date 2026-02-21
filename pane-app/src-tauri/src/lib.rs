mod claude;
mod commands;
mod settings;
#[cfg(target_os = "macos")]
mod traffic_lights;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(commands::AppWatcherState(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .manage(claude::ClaudeProcessState(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            commands::read_directory,
            commands::read_file,
            commands::write_file,
            commands::get_home_dir,
            commands::get_cwd,
            commands::detect_project_root,
            commands::watch_directory,
            commands::unwatch_directory,
            commands::get_git_status,
            commands::walk_project_files,
            commands::delete_file,
            commands::reveal_in_finder,
            commands::search_in_files,
            commands::get_git_log,
            settings::load_settings,
            settings::save_settings,
            claude::send_to_claude,
            claude::abort_claude,
            commands::set_window_title,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    traffic_lights::setup(&window);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
