import type { ClaudeStreamEvent, ConversationMessage, Todo } from "./claude-types";

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

export async function readDirectoryTree(
  path: string,
  maxDepth: number,
): Promise<Record<string, FileEntry[]>> {
  return electronAPI.invoke("read_directory_tree", { path, maxDepth });
}

export async function readFile(path: string): Promise<string> {
  return electronAPI.invoke("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return electronAPI.invoke("write_file", { path, content });
}

export async function loadScrollPositions(): Promise<Record<string, number | "bottom">> {
  return electronAPI.invoke("load_scroll_positions");
}

export async function saveScrollPositions(
  positions: Record<string, number | "bottom">,
): Promise<void> {
  return electronAPI.invoke("save_scroll_positions", { positions });
}

export async function saveConversationToMain(
  filePath: string,
  conversation: { sessionId: string | null; model?: string | null; messages: unknown[] },
): Promise<void> {
  return electronAPI.invoke("save_conversation", { filePath, conversation });
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

export async function renameFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return electronAPI.invoke("rename_file", { oldPath, newPath });
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
  subject: string;  // first line of commit message
  body: string;     // full message body (may repeat subject)
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
  recent_files?: string[];
  scroll_positions?: Record<
    string,
    { scrollTop: number; cursor: { row: number; column: number } }
  >;
}

import type { BackendRouting } from "./models";

export interface UserSettings {
  project_roots: string[];
  active_project_root: string | null;
  control_panel_visible: boolean;
  project_states: Record<string, ProjectSessionState>;
  font_size: number | null;
  panel_font_size: number | null;
  editor_font_size: number | null;
  font_weight: number | null;
  keybindings: Record<
    string,
    { mod: boolean; shift: boolean; alt: boolean; key: string }
  > | null;
  theme: string | null;
  panel_width: number | null;
  completion_sound: string | null;
  selected_model: string | null;
  selected_model_provider?: string;
  punk_backend: string;
  http_provider?: string;
  http_api_key?: string;
  http_api_keys?: Record<string, string>;
  http_base_url?: string;
  http_base_urls?: Record<string, string>;
  intent_routing?: BackendRouting;
  intent_auto_route?: boolean;
}

export async function loadSettings(): Promise<UserSettings> {
  return electronAPI.invoke("load_settings");
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  return electronAPI.invoke("save_settings", { settings });
}

// Claude process management

export async function sendToPunk(
  projectId: string,
  prompt: string,
  workingDir: string,
  sessionId: string | null,
  model: string | null,
  onEvent: (event: ClaudeStreamEvent) => void,
  intent?: string,
  history?: ConversationMessage[],
  thinking?: boolean,
  provider?: string,
  todos?: Todo[],
): Promise<void> {
  const requestId = Math.random().toString(36).slice(2, 11);
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
    if (queue.length === 0) {
      draining = false;
      return;
    }

    // Process events in a time-budgeted batch.
    // Problem: setImmediate in main process can flood the renderer with hundreds
    // of events during a compaction burst. With one-event-per-macrotask, hundreds
    // of pending MessageChannel tasks pile up, each delaying user input by one task.
    // Result: the app appears frozen (clicks fire 500+ tasks later).
    //
    // Fix: process events for up to BUDGET_MS per macrotask, then yield. This
    // drains the backlog fast while still letting the browser handle repaints and
    // user input between batches. If a single event is expensive (assembled
    // assistant message with many blocks), we still yield after processing it.
    const BUDGET_MS = 4; // ~1 frame at 240Hz — imperceptible yield gap
    const deadline = performance.now() + BUDGET_MS;

    while (queue.length > 0) {
      const event = queue.shift()!;
      onEvent(event);
      // Terminal events: clean up after processing, don't schedule another drain.
      if (event.event === "processEnded" || event.event === "error") {
        draining = false;
        port1.close();
        port2.close();
        setTimeout(() => cleanup?.(), 0);
        return;
      }
      // Yield to the browser if we've used up our time budget.
      if (performance.now() >= deadline) break;
    }

    if (queue.length > 0) port1.postMessage(null);
    else draining = false;
  };

  cleanup = electronAPI.on(
    `claude-stream:${projectId}`,
    (event: ClaudeStreamEvent) => {
      // All events go through the MessageChannel queue so the browser can
      // interleave paint/input between each one. The old pattern of
      // synchronously dumping the queue on processEnded caused UI freezes
      // with CLI backends that burst many events right before exit.
      queue.push(event);
      if (!draining) {
        draining = true;
        port1.postMessage(null);
      }
    },
  );

  try {
    await electronAPI.invoke("send_to_punk", {
      projectId,
      prompt,
      workingDir,
      sessionId,
      model,
      intent,
      history,
      requestId,
      thinking,
      provider,
      todos,
    });
  } catch (err) {
    port1.close();
    port2.close();
    cleanup?.();
    throw err;
  }
}

// Backwards-compatible alias while we transition naming in the app.
export const sendToClaude = sendToPunk;

export async function abortPunk(projectId: string): Promise<void> {
  return electronAPI.invoke("abort_punk", { projectId });
}

export async function respondToDiscovery(projectId: string, response: string): Promise<void> {
  return electronAPI.invoke("respond_to_discovery", { projectId, response });
}

export async function approvePlan(projectId: string): Promise<void> {
  return electronAPI.invoke("approve_plan", { projectId });
}

export async function rejectPlan(projectId: string): Promise<void> {
  return electronAPI.invoke("reject_plan", { projectId });
}

export async function terminateClaudeSession(projectId: string): Promise<void> {
  return electronAPI.invoke("terminate_punk_session", { projectId });
}

export async function reinitializePunkBackend(backend?: string): Promise<void> {
  return electronAPI.invoke("reinitialize_punk_backend", { backend });
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  provider: string;      // upstream provider display name, e.g. "Anthropic", "Google"
  tier: 1 | 2 | 3;      // 1=frontier, 2=balanced, 3=fast/cheap
  input_cost: number | null;   // $/Mtok
  output_cost: number | null;  // $/Mtok
}

export async function getOpenRouterModels(): Promise<OpenRouterModel[]> {
  return electronAPI.invoke("get_openrouter_models");
}

export async function getAllModels(): Promise<
  Record<string, OpenRouterModel[]>
> {
  return electronAPI.invoke("get_all_models");
}

export async function refreshAllModels(): Promise<
  Record<string, OpenRouterModel[]>
> {
  return electronAPI.invoke("refresh_all_models");
}

export async function setWindowTitle(title: string): Promise<void> {
  return electronAPI.invoke("set_window_title", { title });
}

// PTY terminal management

export async function createPty(
  ptyId: string,
  projectId: string,
  cwd: string,
): Promise<void> {
  return electronAPI.invoke("pty_create", { ptyId, projectId, cwd });
}

export async function writePty(ptyId: string, data: string): Promise<void> {
  return electronAPI.invoke("pty_write", { ptyId, data });
}

export async function destroyPty(ptyId: string): Promise<void> {
  return electronAPI.invoke("pty_destroy", { ptyId });
}

export async function destroyAllPtysForProject(
  projectId: string,
): Promise<void> {
  return electronAPI.invoke("pty_destroy_project", { projectId });
}

export function onPtyData(
  ptyId: string,
  cb: (data: string) => void,
): () => void {
  return electronAPI.on(`pty-data:${ptyId}`, cb);
}

export function onPtyExit(
  ptyId: string,
  cb: (info: { exitCode: number }) => void,
): () => void {
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

// Gemini process management

export interface GeminiVersionInfo {
  current: string | null;
  error: string | null;
}

export interface GeminiUpdateInfo {
  updateAvailable: boolean;
  currentVersion: string | null;
  newVersion: string | null;
  error: string | null;
}

export interface GeminiUpdateResult {
  success: boolean;
  output: string;
  error: string | null;
}

export async function checkGeminiVersion(): Promise<GeminiVersionInfo> {
  return electronAPI.invoke("check_gemini_version");
}

export async function checkGeminiUpdate(): Promise<GeminiUpdateInfo> {
  return electronAPI.invoke("check_gemini_update");
}

export async function updateGemini(): Promise<GeminiUpdateResult> {
  return electronAPI.invoke("update_gemini");
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
  return electronAPI.invoke("create_checkpoint", {
    projectId,
    workingDir,
    messageId,
  });
}

export async function restoreCheckpoint(
  projectId: string,
  checkpointId: string,
  workingDir: string,
): Promise<RestoreResult> {
  return electronAPI.invoke("restore_checkpoint", {
    projectId,
    checkpointId,
    workingDir,
  });
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
  return electronAPI.invoke("get_checkpoint_diff", {
    projectId,
    checkpointId,
    workingDir,
  });
}

export async function deleteProjectCheckpoints(
  projectId: string,
): Promise<void> {
  return electronAPI.invoke("delete_project_checkpoints", { projectId });
}

// --- Change History ---

export interface ChangeEntry {
  id: string;
  timestamp: number;
  file: string;
  oldString: string;
  newString: string;
  description?: string;
}

export interface ChangeHistoryResult {
  changes: ChangeEntry[];
}

export async function recordChange(
  projectId: string,
  filePath: string,
  oldString: string,
  newString: string,
  description?: string,
  timestamp?: number,
): Promise<{ id: string; success: boolean }> {
  return electronAPI.invoke("record_change", {
    projectId,
    filePath,
    oldString,
    newString,
    description,
    timestamp,
  });
}

export async function getChangeHistory(
  projectId: string,
): Promise<ChangeHistoryResult> {
  return electronAPI.invoke("get_change_history", { projectId });
}

export async function revertChange(
  projectId: string,
  changeId: string,
  workingDir: string,
): Promise<{ success: boolean; output?: string; error?: string; file?: string }> {
  return electronAPI.invoke("revert_change", {
    projectId,
    changeId,
    workingDir,
  });
}

export async function searchChanges(
  projectId: string,
  query?: string,
  filePath?: string,
): Promise<ChangeHistoryResult> {
  return electronAPI.invoke("search_changes", {
    projectId,
    query,
    filePath,
  });
}

export async function deleteChangeHistory(
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  return electronAPI.invoke("delete_change_history", { projectId });
}

// --- Git Auto-Draft ---

export async function draftCommitMessage(
  projectId: string,
  root: string,
): Promise<{ draft: string; error?: string }> {
  return electronAPI.invoke("draft_commit_message", { projectId, root });
}

export async function getAheadBehind(path: string): Promise<{ ahead: number; behind: number }> {
  return electronAPI.invoke("git_ahead_behind", { path });
}

export async function listBranches(path: string): Promise<{ branches: string[]; error?: string }> {
  return electronAPI.invoke("git_list_branches", { path });
}

export async function checkoutBranch(path: string, branch: string): Promise<{ success: boolean; error?: string }> {
  return electronAPI.invoke("git_checkout", { path, branch });
}

// --- Pane Intelligence Layer: State + Memory ---

export interface EditorState {
  activeFile: string | null;
  content: string | null;
  recentFiles: string[];
}

export interface TerminalCommand {
  cmd: string;
  output: string;
  cwd: string;
  timestamp: number;
}

export interface TerminalState {
  commands: TerminalCommand[];
}

export interface ProjectState {
  name: string;
  root: string;
  gitBranch: string | null;
  topLevelFiles: string[];
}

export async function writeEditorState(
  projectId: string,
  data: EditorState,
): Promise<void> {
  return electronAPI.invoke("write_editor_state", { projectId, data });
}

export async function writeTerminalState(
  projectId: string,
  data: TerminalState,
): Promise<void> {
  return electronAPI.invoke("write_terminal_state", { projectId, data });
}

export async function writeProjectState(
  projectId: string,
  data: ProjectState,
): Promise<void> {
  return electronAPI.invoke("write_project_state", { projectId, data });
}

export async function recordMemoryEvents(
  projectId: string,
  events: import("./claude-types").MemoryEvent[],
): Promise<void> {
  return electronAPI.invoke("record_memory_events", { projectId, events });
}

export async function generateBrief(projectId: string): Promise<string> {
  return electronAPI.invoke("generate_brief", { projectId });
}

export async function readBrief(projectId: string): Promise<string> {
  return electronAPI.invoke("read_brief", { projectId });
}

// --- Pane Brain Engine ---

export interface BrainSearchResult {
  id: string;
  name: string;
  type: string;
  content: string;
  confidence: number;
  score: number;
  age: string;
}

export async function brainIndexEvents(
  projectId: string,
  events: import("./claude-types").MemoryEvent[],
): Promise<{ indexed: number; deduplicated: number }> {
  return electronAPI.invoke("brain_index_events", { projectId, events });
}

export async function brainSearch(
  query: string,
  projectId: string,
  limit?: number,
): Promise<{ results: BrainSearchResult[] }> {
  return electronAPI.invoke("brain_search", {
    query,
    projectId,
    limit: limit ?? 10,
  });
}

export async function brainContextualSearch(
  projectId: string,
  query: string,
  fileContext?: string,
  intent?: string,
  projectRoot?: string,
): Promise<{
  memories: BrainSearchResult[];
  tensions: unknown[];
  profileAtoms: unknown[];
  relevantFiles: unknown[];
}> {
  return electronAPI.invoke("brain_contextual_search", {
    projectId,
    query,
    fileContext,
    intent,
    projectRoot,
  });
}

export async function brainGetStats(): Promise<{
  node_count: number;
  edge_count: number;
  version_count: number;
}> {
  return electronAPI.invoke("brain_get_stats");
}

export interface IntelligenceStats {
  totalNodes: number;
  highConfidence: number;
  lowConfidence: number;
  totalEdges: number;
  crossProjectEdges: number;
  connectedNodes: number;
  byType: Record<string, number>;
}

export async function brainGetIntelligenceStats(
  projectId: string,
): Promise<{ stats: IntelligenceStats | null }> {
  return electronAPI.invoke("brain_get_intelligence_stats", { projectId });
}

// --- Profile ---

export interface UserProfile {
  identity: {
    name: string;
    bio: string;
    role: string;
    avatar: string | null;
  } | null;
  preferences: {
    coding: Record<
      string,
      { confidence: number; source: string; content: string }
    >;
    communication: Record<string, unknown>;
    tools: Record<
      string,
      { confidence: number; source: string; content: string }
    >;
  } | null;
  antiPatterns: {
    patterns: Array<{
      error: string;
      fix: string;
      confidence: number;
      source: string;
    }>;
  } | null;
  style: { verbosity: string; planFirst: boolean } | null;
  rules: string;
  philosophy: string;
}

export async function brainGetProfile(): Promise<{ profile: UserProfile }> {
  return electronAPI.invoke("brain_get_profile");
}

export async function brainAddRule(
  rule: string,
): Promise<{ added: boolean; reason?: string }> {
  return electronAPI.invoke("brain_add_rule", { rule });
}

export async function brainUpdatePhilosophy(
  text: string,
): Promise<{ updated: boolean }> {
  return electronAPI.invoke("brain_update_philosophy", { text });
}

export async function brainUpdateRules(
  text: string,
): Promise<{ updated: boolean }> {
  return electronAPI.invoke("brain_update_rules", { text });
}

export async function brainExtractProfile(): Promise<void> {
  return electronAPI.invoke("brain_extract_profile");
}

export async function brainClearSessionPins(projectId: string): Promise<void> {
  return electronAPI.invoke("brain_session_pins_clear", { projectId });
}

// --- Identity ---

export interface UserIdentity {
  name: string;
  bio: string;
  role: string;
  avatar: string | null;
}

export async function brainUpdateIdentity(
  identity: Partial<UserIdentity>,
): Promise<{ updated: boolean }> {
  return electronAPI.invoke("brain_update_identity", { identity });
}

export async function brainSaveAvatar(
  base64Data: string,
  mimeType: string,
): Promise<{ path: string }> {
  return electronAPI.invoke("brain_save_avatar", { base64Data, mimeType });
}

export async function brainGetAvatar(): Promise<{
  base64: string | null;
  mime: string | null;
}> {
  return electronAPI.invoke("brain_get_avatar");
}

// --- Mind ---

export interface MindEntry {
  id: string;
  content: string;
  completed?: boolean;
  created_at: string;
  updated_at: string;
}

export async function brainMindAdd(
  content: string,
): Promise<{ entry: MindEntry }> {
  return electronAPI.invoke("brain_mind_add", { content });
}

export async function brainMindGetAll(): Promise<{ entries: MindEntry[] }> {
  return electronAPI.invoke("brain_mind_get_all");
}

export async function brainMindUpdate(
  id: string,
  content?: string,
  completed?: boolean,
): Promise<{ entry: MindEntry | null }> {
  return electronAPI.invoke("brain_mind_update", { id, content, completed });
}

export async function brainMindDelete(id: string): Promise<{ id: string }> {
  return electronAPI.invoke("brain_mind_delete", { id });
}

// --- Session Context ---

export interface SessionState {
  activeTask: { description: string; goal?: string } | null;
  workingSet: { path: string; purpose?: string; touches: number }[];
  decisions: { content: string; timestamp: number }[];
  recentActions: { type: string; content: string; timestamp: number }[];
  turnCount: number;
  lastProvider: string | null;
  lastIntent: string | null;
  startedAt: number;
}

export interface SessionDelta {
  activeTask?: { description: string; goal?: string } | null;
  todos?: { content: string; status: string; activeForm?: string }[];
  workingSet?: { path: string; purpose?: string }[];
  decisions?: { content: string }[];
  recentActions?: { type: string; content: string; timestamp: number }[];
  methodNotes?: { type: string; content: string; timestamp: number }[];
  turnCount?: number;
  lastProvider?: string;
  lastIntent?: string;
  gitStatus?: { branch: string; summary: string } | null;
}

export async function sessionMergeState(
  projectId: string,
  delta: SessionDelta,
): Promise<SessionState> {
  return electronAPI.invoke("session_merge_state", { projectId, delta });
}

export async function sessionClearState(
  projectId: string,
): Promise<SessionState> {
  return electronAPI.invoke("session_clear_state", { projectId });
}

export async function sessionReadState(
  projectId: string,
): Promise<SessionState | null> {
  return electronAPI.invoke("session_read_state", { projectId });
}
