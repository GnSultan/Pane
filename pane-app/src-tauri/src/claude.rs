use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Holds running Claude process PIDs keyed by project_id.
pub struct ClaudeProcessState(pub Mutex<HashMap<String, u32>>);

/// Events streamed to the frontend via Tauri Channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ClaudeStreamEvent {
    ProcessStarted,
    Message { raw_json: String },
    ProcessEnded { exit_code: Option<i32> },
    Error { message: String },
}

#[tauri::command]
pub async fn send_to_claude(
    project_id: String,
    prompt: String,
    working_dir: String,
    session_id: Option<String>,
    on_event: Channel<ClaudeStreamEvent>,
    state: State<'_, ClaudeProcessState>,
) -> Result<(), String> {
    // Build the claude command arguments
    // --dangerously-skip-permissions: Pane gives Claude full access — no tool
    // approval prompts. The user trusts Claude to act autonomously within the
    // project. Without this, the non-interactive CLI can't get user consent.
    let mut cmd_parts = vec![
        "claude".to_string(),
        "-p".to_string(),
        prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--max-turns".to_string(),
        "50".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--append-system-prompt".to_string(),
        "For non-trivial tasks, present a brief plan FIRST and end with: \"Ready to proceed — send 'go' to start.\" Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.".to_string(),
    ];

    if let Some(sid) = session_id {
        cmd_parts.push("--resume".to_string());
        cmd_parts.push(sid);
    }

    // Shell-escape each argument and join
    let shell_cmd = cmd_parts
        .iter()
        .map(|arg| shell_escape(arg))
        .collect::<Vec<_>>()
        .join(" ");

    // macOS GUI apps don't inherit the user's shell PATH, so we source
    // path_helper (macOS standard PATH) + .zshrc (nvm, user additions).
    // We avoid login shell (-l) because it loads .zprofile which can cause
    // Node.js tool crashes in some environments.
    let full_cmd = format!(
        "eval $(/usr/libexec/path_helper -s 2>/dev/null); \
         [ -f \"$HOME/.zshrc\" ] && source \"$HOME/.zshrc\" 2>/dev/null; \
         {}",
        shell_cmd
    );

    let mut child = Command::new("/bin/zsh")
        .args(["-c", &full_cmd])
        .current_dir(&working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to spawn claude: {}. Is claude CLI installed and in PATH?",
                e
            )
        })?;

    // Store the pid for abort capability
    let pid = child.id().ok_or("Failed to get process ID")?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.insert(project_id.clone(), pid);
    }

    on_event
        .send(ClaudeStreamEvent::ProcessStarted)
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let on_event_err = on_event.clone();

    // Spawn stderr reader
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let mut output = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            output.push_str(&line);
            output.push('\n');
        }
        output
    });

    // Read stdout line by line and forward to frontend
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if on_event
            .send(ClaudeStreamEvent::Message {
                raw_json: line,
            })
            .is_err()
        {
            // Channel closed — frontend navigated away
            break;
        }
    }

    // Wait for process to finish
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let exit_code = status.code();

    // If non-zero exit, include stderr
    if exit_code != Some(0) {
        if let Ok(stderr_output) = stderr_handle.await {
            let trimmed = stderr_output.trim().to_string();
            if !trimmed.is_empty() {
                let _ = on_event_err.send(ClaudeStreamEvent::Error {
                    message: trimmed,
                });
            }
        }
    }

    let _ = on_event.send(ClaudeStreamEvent::ProcessEnded { exit_code });

    // Remove from active processes
    if let Ok(mut guard) = state.0.lock() {
        guard.remove(&project_id);
    }

    Ok(())
}

#[tauri::command]
pub async fn abort_claude(
    project_id: String,
    state: State<'_, ClaudeProcessState>,
) -> Result<(), String> {
    let pid = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.get(&project_id).copied()
    };

    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.remove(&project_id);
    }

    Ok(())
}

/// Shell-escape a string for safe use in a shell command.
fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    // If the string contains no special characters, return as-is
    if s.chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/' || c == ':')
    {
        return s.to_string();
    }
    // Wrap in single quotes, escaping any existing single quotes
    format!("'{}'", s.replace('\'', "'\\''"))
}
