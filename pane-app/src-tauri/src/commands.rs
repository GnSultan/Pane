use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use tauri::State;

/// Set window title and re-pin traffic lights on macOS.
/// Direct setTitle calls from JS reset traffic light positions.
#[tauri::command]
pub fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    crate::traffic_lights::position_traffic_lights(&window);
    Ok(())
}

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_hidden: bool,
    extension: Option<String>,
}

#[tauri::command]
pub fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for entry in dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .DS_Store
        if name == ".DS_Store" {
            continue;
        }

        let file_path = entry.path().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();
        let is_hidden = name.starts_with('.');
        let extension = if is_dir {
            None
        } else {
            Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
        };

        entries.push(FileEntry {
            name,
            path: file_path,
            is_dir,
            is_hidden,
            extension,
        });
    }

    // Sort: directories first, then files, both alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let metadata =
        fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

    // Reject files larger than 5MB
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File too large (>5MB)".to_string());
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Check for binary content (null bytes in first 8KB)
    let check_len = bytes.len().min(8192);
    if bytes[..check_len].contains(&0) {
        return Err("Binary file — cannot display".to_string());
    }

    String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8".to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "Could not determine home directory".to_string())
}

#[tauri::command]
pub fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get cwd: {}", e))
}

#[tauri::command]
pub fn detect_project_root(start_path: String) -> Result<String, String> {
    let mut current = std::path::PathBuf::from(&start_path);
    loop {
        if current.join(".git").exists() {
            return Ok(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            return Ok(start_path);
        }
    }
}

// --- File Watcher (multi-project) ---

pub struct AppWatcherState(pub Mutex<HashMap<String, crate::watcher::WatcherState>>);

#[tauri::command]
pub fn watch_directory(
    app: tauri::AppHandle,
    path: String,
    state: State<'_, AppWatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.contains_key(&path) {
        return Ok(()); // already watching
    }
    let watcher_state = crate::watcher::start_watching(&app, path.clone())?;
    guard.insert(path, watcher_state);
    Ok(())
}

#[tauri::command]
pub fn unwatch_directory(
    path: String,
    state: State<'_, AppWatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    guard.remove(&path);
    Ok(())
}

// --- Git Status ---

#[derive(Serialize)]
pub struct GitStatusInfo {
    pub branch: String,
    pub files: HashMap<String, String>,
}

#[tauri::command]
pub fn get_git_status(path: String) -> Result<GitStatusInfo, String> {
    // Use symbolic-ref first (works on empty repos), fall back to rev-parse
    let branch_output = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let branch = if branch_output.status.success() {
        String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_string()
    } else {
        // Detached HEAD or other edge case
        let fallback = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output()
            .ok();
        fallback
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "master".to_string())
    };

    let status_output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    let mut files = HashMap::new();
    if status_output.status.success() {
        let stdout = String::from_utf8_lossy(&status_output.stdout);
        for line in stdout.lines() {
            if line.len() < 4 {
                continue;
            }
            let status_code = line[..2].trim().to_string();
            let file_path = line[3..].to_string();
            let actual_path = if let Some(arrow_pos) = file_path.find(" -> ") {
                file_path[arrow_pos + 4..].to_string()
            } else {
                file_path
            };
            files.insert(actual_path, status_code);
        }
    }

    Ok(GitStatusInfo { branch, files })
}

// --- Fuzzy Finder: Walk Project Files ---

#[tauri::command]
pub fn walk_project_files(root: String) -> Result<Vec<String>, String> {
    use ignore::WalkBuilder;

    let root_path = Path::new(&root);
    let mut files = Vec::new();

    for entry in WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build()
    {
        match entry {
            Ok(entry) => {
                if entry.file_type().map_or(false, |ft| ft.is_file()) {
                    if let Ok(relative) = entry.path().strip_prefix(root_path) {
                        files.push(relative.to_string_lossy().to_string());
                    }
                }
            }
            Err(_) => continue,
        }
    }

    files.sort();
    Ok(files)
}

// --- Context Menu Actions ---

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    Ok(())
}

// --- Search Across Files ---

#[derive(Serialize)]
pub struct SearchResult {
    pub file_path: String,
    pub absolute_path: String,
    pub line_number: usize,
    pub line_content: String,
}

#[tauri::command]
pub fn search_in_files(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    use ignore::WalkBuilder;

    let max = max_results.unwrap_or(200);
    let root_path = Path::new(&root);
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for entry in WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build()
    {
        if results.len() >= max {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().map_or(false, |ft| ft.is_file()) {
            continue;
        }

        let path = entry.path();

        // Skip large files
        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > 2 * 1024 * 1024 {
            continue;
        }

        let content = match fs::read(path) {
            Ok(bytes) => {
                let check_len = bytes.len().min(512);
                if bytes[..check_len].contains(&0) {
                    continue;
                }
                match String::from_utf8(bytes) {
                    Ok(s) => s,
                    Err(_) => continue,
                }
            }
            Err(_) => continue,
        };

        for (line_idx, line) in content.lines().enumerate() {
            if results.len() >= max {
                break;
            }
            if line.to_lowercase().contains(&query_lower) {
                let relative = path
                    .strip_prefix(root_path)
                    .map(|r| r.to_string_lossy().to_string())
                    .unwrap_or_else(|_| path.to_string_lossy().to_string());
                results.push(SearchResult {
                    file_path: relative,
                    absolute_path: path.to_string_lossy().to_string(),
                    line_number: line_idx + 1,
                    line_content: line.chars().take(200).collect(),
                });
            }
        }
    }

    Ok(results)
}

// --- Git Log ---

#[derive(Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[tauri::command]
pub fn get_git_log(path: String, count: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let max = count.unwrap_or(50);
    let output = Command::new("git")
        .args([
            "log",
            &format!("-{}", max),
            "--pretty=format:%h\x1f%s\x1f%an\x1f%ar",
        ])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() >= 4 {
                Some(GitCommit {
                    hash: parts[0].to_string(),
                    message: parts[1].to_string(),
                    author: parts[2].to_string(),
                    date: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(commits)
}
