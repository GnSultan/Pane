use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
pub struct FileChangeEvent {
    pub paths: Vec<String>,
}

pub struct WatcherState {
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

pub fn start_watching(app: &AppHandle, root_path: String) -> Result<WatcherState, String> {
    let app_handle = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let paths: Vec<String> = events
                    .iter()
                    .map(|e| e.path.to_string_lossy().to_string())
                    .collect();

                if !paths.is_empty() {
                    let _ = app_handle.emit("pane://file-changed", FileChangeEvent { paths });
                }
            }
            Err(errors) => {
                eprintln!("Watcher errors: {:?}", errors);
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(
            Path::new(&root_path),
            notify::RecursiveMode::Recursive,
        )
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    Ok(WatcherState {
        _debouncer: debouncer,
    })
}
