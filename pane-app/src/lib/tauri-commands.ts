import { invoke, Channel } from "@tauri-apps/api/core";
import type { ClaudeStreamEvent } from "./claude-types";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  extension: string | null;
}

export async function readDirectory(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("read_directory", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export async function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

export async function getCwd(): Promise<string> {
  return invoke<string>("get_cwd");
}

export async function detectProjectRoot(startPath: string): Promise<string> {
  return invoke<string>("detect_project_root", { startPath });
}

export async function watchDirectory(path: string): Promise<void> {
  return invoke<void>("watch_directory", { path });
}

export async function unwatchDirectory(path: string): Promise<void> {
  return invoke<void>("unwatch_directory", { path });
}

export interface GitStatusInfo {
  branch: string;
  files: Record<string, string>;
}

export async function getGitStatus(path: string): Promise<GitStatusInfo> {
  return invoke<GitStatusInfo>("get_git_status", { path });
}

export async function walkProjectFiles(root: string): Promise<string[]> {
  return invoke<string[]>("walk_project_files", { root });
}

export async function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
}

export async function revealInFinder(path: string): Promise<void> {
  return invoke<void>("reveal_in_finder", { path });
}

export interface SearchResult {
  file_path: string;
  absolute_path: string;
  line_number: number;
  line_content: string;
}

export async function searchInFiles(
  root: string,
  query: string,
  maxResults?: number,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("search_in_files", {
    root,
    query,
    maxResults: maxResults ?? 200,
  });
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export async function getGitLog(
  path: string,
  count?: number,
): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("get_git_log", { path, count: count ?? 50 });
}

export interface ProjectSessionState {
  expanded_dirs: string[];
  active_file_path: string | null;
}

export interface UserSettings {
  project_roots: string[];
  active_project_root: string | null;
  control_panel_visible: boolean;
  project_states: Record<string, ProjectSessionState>;
  font_size: number | null;
  panel_font_size: number | null;
  theme: string | null;
  panel_width: number | null;
}

export async function loadSettings(): Promise<UserSettings> {
  return invoke<UserSettings>("load_settings");
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

// Claude process management

export async function sendToClaude(
  projectId: string,
  prompt: string,
  workingDir: string,
  sessionId: string | null,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<ClaudeStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("send_to_claude", {
    projectId,
    prompt,
    workingDir,
    sessionId,
    onEvent: channel,
  });
}

export async function abortClaude(projectId: string): Promise<void> {
  return invoke<void>("abort_claude", { projectId });
}

export async function setWindowTitle(title: string): Promise<void> {
  return invoke<void>("set_window_title", { title });
}
