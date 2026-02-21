use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ProjectState {
    pub expanded_dirs: Vec<String>,
    pub active_file_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UserSettings {
    pub project_roots: Vec<String>,
    pub active_project_root: Option<String>,
    pub control_panel_visible: bool,
    #[serde(default)]
    pub project_states: HashMap<String, ProjectState>,
    #[serde(default)]
    pub font_size: Option<u32>,
    #[serde(default)]
    pub panel_font_size: Option<u32>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub panel_width: Option<f64>,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            project_roots: Vec::new(),
            active_project_root: None,
            control_panel_visible: true,
            project_states: HashMap::new(),
            font_size: None,
            panel_font_size: None,
            theme: None,
            panel_width: None,
        }
    }
}

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".pane").join("settings.json")
}

#[tauri::command]
pub fn load_settings() -> Result<UserSettings, String> {
    let path = settings_path();
    if !path.exists() {
        return Ok(UserSettings::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

#[tauri::command]
pub fn save_settings(settings: UserSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write settings: {}", e))
}
