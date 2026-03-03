import type { ClaudeStreamEvent } from "./claude-types";

// Electron IPC bridge
const electronAPI = (window as any).electronAPI;

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  extension: string | null;
}

export async function readDirectory(path: string): Promise<FileEntry[]> {
  return electronAPI.invoke("read_directory", { path });
}

export async function readDirectoryTree(path: string, maxDepth: number): Promise<Record<string, FileEntry[]>> {
  return electronAPI.invoke("read_directory_tree", { path, maxDepth });
}

export async function readFile(path: string): Promise<string> {
  return electronAPI.invoke("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return electronAPI.invoke("write_file", { path, content });
}

export async function getHomeDir(): Promise<string> {
  return electronAPI.invoke("get_home_dir");
}

export async function getCwd(): Promise<string> {
  return electronAPI.invoke("get_cwd");
}

export async function detectProjectRoot(startPath: string): Promise<string> {
  return electronAPI.invoke("detect_project_root", { startPath });
}

export async function watchDirectory(path: string): Promise<void> {
  return electronAPI.invoke("watch_directory", { path });
}

export async function unwatchDirectory(path: string): Promise<void> {
  return electronAPI.invoke("unwatch_directory", { path });
}

export interface GitStatusInfo {
  branch: string;
  files: Record<string, string>;
}

export async function getGitStatus(path: string): Promise<GitStatusInfo> {
  return electronAPI.invoke("get_git_status", { path });
}

export async function walkProjectFiles(root: string): Promise<string[]> {
  return electronAPI.invoke("walk_project_files", { root });
}

export async function deleteFile(path: string): Promise<void> {
  return electronAPI.invoke("delete_file", { path });
}

export async function revealInFinder(path: string): Promise<void> {
  return electronAPI.invoke("reveal_in_finder", { path });
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
  return electronAPI.invoke("search_in_files", {
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
  return electronAPI.invoke("get_git_log", { path, count: count ?? 50 });
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
  editor_font_size: number | null;
  font_weight: number | null;
  keybindings: Record<string, { mod: boolean; shift: boolean; alt: boolean; key: string }> | null;
  theme: string | null;
  panel_width: number | null;
  completion_sound: string | null;
  selected_model: string | null;
}

export async function loadSettings(): Promise<UserSettings> {
  return electronAPI.invoke("load_settings");
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  return electronAPI.invoke("save_settings", { settings });
}

// Claude process management

export async function sendToClaude(
  projectId: string,
  prompt: string,
  workingDir: string,
  sessionId: string | null,
  model: string | null,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<void> {
  // Self-cleaning listener — stays active until processEnded or error
  let cleanup: (() => void) | null = null;

  // MessageChannel-based event yielding — same technique React's scheduler uses.
  // Instead of processing all IPC events synchronously (starving clicks/inputs),
  // we queue events and drain one-per-task via MessageChannel.postMessage
  // which yields to the browser between each event (zero-delay, no setTimeout 4ms minimum).
  const queue: ClaudeStreamEvent[] = [];
  let draining = false;
  const { port1, port2 } = new MessageChannel();

  port2.onmessage = () => {
    if (queue.length === 0) { draining = false; return; }
    const event = queue.shift()!;
    onEvent(event);
    if (queue.length > 0) port1.postMessage(null);
    else draining = false;
  };

  cleanup = electronAPI.on(`claude-stream:${projectId}`, (event: ClaudeStreamEvent) => {
    // Critical events bypass queue — must process immediately.
    // Drain queued events FIRST so ordering is preserved (they happened before
    // this terminal event). Then process the terminal event itself.
    if (event.event === "processEnded" || event.event === "error") {
      while (queue.length > 0) onEvent(queue.shift()!);
      onEvent(event);
      draining = false;
      port1.close();
      port2.close();
      setTimeout(() => cleanup?.(), 0);
      return;
    }
    queue.push(event);
    if (!draining) { draining = true; port1.postMessage(null); }
  });

  try {
    await electronAPI.invoke("send_to_claude", {
      projectId,
      prompt,
      workingDir,
      sessionId,
      model,
    });
  } catch (err) {
    port1.close();
    port2.close();
    cleanup?.();
    throw err;
  }
}

export async function abortClaude(projectId: string): Promise<void> {
  return electronAPI.invoke("abort_claude", { projectId });
}

export async function terminateClaudeSession(projectId: string): Promise<void> {
  return electronAPI.invoke("terminate_claude_session", { projectId });
}

export async function setWindowTitle(title: string): Promise<void> {
  return electronAPI.invoke("set_window_title", { title });
}

// PTY terminal management

export async function createPty(ptyId: string, projectId: string, cwd: string): Promise<void> {
  return electronAPI.invoke("pty_create", { ptyId, projectId, cwd });
}

export async function writePty(ptyId: string, data: string): Promise<void> {
  return electronAPI.invoke("pty_write", { ptyId, data });
}

export async function destroyPty(ptyId: string): Promise<void> {
  return electronAPI.invoke("pty_destroy", { ptyId });
}

export async function destroyAllPtysForProject(projectId: string): Promise<void> {
  return electronAPI.invoke("pty_destroy_project", { projectId });
}

export function onPtyData(ptyId: string, cb: (data: string) => void): () => void {
  return electronAPI.on(`pty-data:${ptyId}`, cb);
}

export function onPtyExit(ptyId: string, cb: (info: { exitCode: number }) => void): () => void {
  return electronAPI.on(`pty-exit:${ptyId}`, cb);
}

export async function getClaudePlanInfo(): Promise<string | null> {
  return electronAPI.invoke("get_claude_plan_info");
}

export interface ClaudeVersionInfo {
  current: string | null;
  error: string | null;
}

export interface ClaudeUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string | null;
  newVersion: string | null;
  error: string | null;
}

export interface ClaudeUpdateResult {
  success: boolean;
  output: string;
  error: string | null;
}

export async function checkClaudeVersion(): Promise<ClaudeVersionInfo> {
  return electronAPI.invoke("check_claude_version");
}

export async function checkClaudeUpdate(): Promise<ClaudeUpdateInfo> {
  return electronAPI.invoke("check_claude_update");
}

export async function updateClaude(): Promise<ClaudeUpdateResult> {
  return electronAPI.invoke("update_claude");
}

// --- File Checkpoints ---

export interface CheckpointResult {
  id: string | null;
  fileCount: number;
  timestamp?: number;
}

export interface RestoredFile {
  path: string;
  action: "restored" | "deleted" | "git_restored" | "orphaned_new";
}

export interface RestoreResult {
  success: boolean;
  restoredFiles: RestoredFile[];
  error?: string;
}

export interface CheckpointDiffFile {
  relativePath: string;
  status: "modified" | "created" | "deleted";
}

export async function createCheckpoint(
  projectId: string,
  workingDir: string,
  messageId: string,
): Promise<CheckpointResult> {
  return electronAPI.invoke("create_checkpoint", { projectId, workingDir, messageId });
}

export async function restoreCheckpoint(
  projectId: string,
  checkpointId: string,
  workingDir: string,
): Promise<RestoreResult> {
  return electronAPI.invoke("restore_checkpoint", { projectId, checkpointId, workingDir });
}

export async function listCheckpoints(
  projectId: string,
): Promise<import("./claude-types").CheckpointMeta[]> {
  return electronAPI.invoke("list_checkpoints", { projectId });
}

export async function getCheckpointDiff(
  projectId: string,
  checkpointId: string,
  workingDir: string,
): Promise<{ files: CheckpointDiffFile[] }> {
  return electronAPI.invoke("get_checkpoint_diff", { projectId, checkpointId, workingDir });
}

export async function deleteProjectCheckpoints(projectId: string): Promise<void> {
  return electronAPI.invoke("delete_project_checkpoints", { projectId });
}
