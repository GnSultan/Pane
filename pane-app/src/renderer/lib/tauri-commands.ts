import type { PunkStreamEvent, ConversationMessage, Todo } from "./punk-types";

// Electron IPC bridge
import type { ElectronAPI } from "./electron";
const electronAPI: ElectronAPI = window.electronAPI;


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

export async function checkPathExists(path: string): Promise<boolean> {
  return electronAPI.invoke("check-path-exists", { path });
}

export async function migrateProjectId(
  oldId: string,
  newId: string,
): Promise<{ success: boolean; error?: string }> {
  return electronAPI.invoke("migrate-project-id", { oldId, newId });
}

export async function rebindProject(
  projectId: string,
  oldRoot: string,
  newRoot: string,
): Promise<{ success: boolean; error?: string }> {
  return electronAPI.invoke("rebind-project", { projectId, oldRoot, newRoot });
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
  projectId: string,
  conversation: { model?: string | null; messages: unknown[]; startIndex?: number },
): Promise<void> {
  return electronAPI.invoke("save_conversation", { projectId, conversation });
}

export interface TokenAnalyticsRow {
  model: string;
  provider: string;
  activity_type: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_cost_usd: number;
  avg_duration_ms: number;
  call_count: number;
  last_used: number;
  unknown_cost_count: number;
  api_reported_count: number;
  estimated_count: number;
  latest_rate_snapshot: string | null;
}

export interface TokenTimeSeriesRow {
  day: string;
  daily_cost: number;
  daily_input: number;
  daily_output: number;
  daily_cache_read: number;
  daily_calls: number;
  unknown_cost_count: number;
  api_reported_count: number;
  estimated_count: number;
}

export async function getTokenAnalytics(
  projectId: string | null,
  sinceMs: number = 0,
): Promise<TokenAnalyticsRow[]> {
  return electronAPI.invoke("get_token_analytics", { projectId, sinceMs });
}

export async function getTokenTimeSeries(
  projectId: string | null,
  sinceMs: number = 0,
): Promise<TokenTimeSeriesRow[]> {
  return electronAPI.invoke("get_token_timeseries", { projectId, sinceMs });
}

export async function getModelRates(models: string[]): Promise<Record<string, { input: number; output: number; cache_read?: number } | null>> {
  return electronAPI.invoke("get_model_rates", { models });
}

export async function getConversationSlice(
  projectId: string,
  count: number,
  beforeIndex?: number,
): Promise<{
  messages: unknown[];
  totalCount: number;
  startIndex: number;
  model: string | null;
}> {
  return electronAPI.invoke("get_conversation_slice", { projectId, count, beforeIndex });
}

export async function searchConversations(
  query: string,
  projectId?: string | null,
  limit = 20,
): Promise<{ results: Array<{ message: unknown; projectId: string }> }> {
  return electronAPI.invoke("search_conversations", { query, projectId: projectId ?? null, limit });
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

/** Opens a native file/folder picker (files + dirs, multi-select).
 *  Paths inside projectRoot are returned relative; others are absolute. */
export async function showFilePicker(
  defaultPath: string,
  projectRoot: string,
): Promise<string[] | null> {
  return electronAPI.invoke("show-file-picker", { defaultPath, projectRoot });
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

import type { PowerCombo } from "./models";

export interface ProjectSessionState {
  /** The project root path. Stored here so UUID-keyed states survive even
   *  when project_ids/project_order are absent from the settings file. */
  root?: string;
  expanded_dirs: string[];
  active_file_path: string | null;
  recent_files?: string[];
  scroll_positions?: Record<
    string,
    { scrollTop: number; cursor: { row: number; column: number } }
  >;
  name?: string;
  /** Per-project power combo override. When set, this project uses
   *  its own thinking/execution models instead of the global default. */
  power_combo?: PowerCombo;
  /** Per-project auto-route toggle. */
  auto_escalate?: boolean;
  /** Per-project explicit model pin. */
  selected_model?: string;
  /** Per-project model provider. */
  selected_model_provider?: string;
  /** Per-project thinking override. */
  selected_model_thinking?: boolean;
  /** When true, this thread is archived. Migrates to conversation-level
   *  is_archived when multi-conversation (Phase 0) lands. */
  archived?: boolean;
}

export interface UserSettings {
  project_roots: string[];
  /** Ordered list of project IDs — the single source of truth for which
   *  threads exist and in what order. Absent in old settings files; the
   *  load side falls back to deduplicated project_roots. */
  project_order?: string[];
  project_ids?: Record<string, string>;
  active_project_root: string | null;
  thread_panel_visible: boolean;
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
  http_api_keys?: Record<string, string>;
  http_base_urls?: Record<string, string>;
  disabled_providers?: string[];
  curated_models?: string[];
  intent_routing?: Record<string, unknown>;  // deprecated — migration only
  power_combo?: PowerCombo;
  intent_auto_route?: boolean;
}

export async function loadSettings(): Promise<UserSettings> {
  return electronAPI.invoke("load_settings");
}

export async function saveSettings(settings: Partial<UserSettings>): Promise<void> {
  return electronAPI.invoke("save_settings", { settings });
}

// Punk engine process management

export interface SendToPunkOptions {
  intent?: string;
  history?: ConversationMessage[];
  thinking?: boolean;
  provider?: string;
  todos?: Todo[];
  autoRoute?: boolean;
  minds?: Array<{ id: string }>;
  /** Per-project power combo: which model to use for each phase.
   *  When present, the backend uses this instead of reading from disk. */
  powerCombo?: PowerCombo;
  /** Sticky phase from the phase pill — single source of truth for model routing.
   *  "think" uses thinking model (plan+verify), "build" uses execution model.
   *  When set, overrides heuristic router so routing stays consistent across turns. */
  phase?: string;
  // Mind chat overrides — when projectId starts with "mind:", these control behavior
  systemPromptOverride?: string;
  _systemOverride?: boolean;
  tools?: string[];
  maxTurns?: number;
}

export async function sendToPunk(
  projectId: string,
  prompt: string,
  workingDir: string,
  model: string | null,
  onEvent: (event: PunkStreamEvent) => void,
  intentOrOptions?: string | SendToPunkOptions,
  history?: ConversationMessage[],
  thinking?: boolean,
  provider?: string,
  todos?: Todo[],
  autoRoute?: boolean,
): Promise<void> {
  // Support both old positional args and new options object
  let opts: SendToPunkOptions;
  if (typeof intentOrOptions === 'object' && intentOrOptions !== null && !Array.isArray(intentOrOptions)) {
    opts = intentOrOptions;
  } else {
    opts = {
      intent: intentOrOptions as string | undefined,
      history,
      thinking,
      provider,
      todos,
      autoRoute,
    };
  }

  const requestId = Math.random().toString(36).slice(2, 11);
  // Self-cleaning listener — stays active until processEnded/error (or
  // orchestration_complete/orchestration_error when orchestration is active).
  let cleanup: (() => void) | null = null;

  const closeListener = () => {
    draining = false;
    port1.close();
    port2.close();
    setTimeout(() => cleanup?.(), 0);
  };

  // MessageChannel-based event yielding — same technique React's scheduler uses.
  // Instead of processing all IPC events synchronously (starving clicks/inputs),
  // we queue events and drain one-per-task via MessageChannel.postMessage
  // which yields to the browser between each event (zero-delay, no setTimeout 4ms minimum).
  const queue: PunkStreamEvent[] = [];
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

      // Terminal events: close the listener and stop draining.
      const isTerminal =
        event.event === "error" ||
        event.event === "processEnded";

      if (isTerminal) {
        closeListener();
        return;
      }

      // Yield to the browser if we've used up our time budget.
      if (performance.now() >= deadline) break;
    }

    if (queue.length > 0) port1.postMessage(null);
    else draining = false;
  };

  // Chunk buffer for large IPC payloads. Keyed by `${requestId}:${eventType}`.
  const chunkBuffer = new Map<string, { chunks: string[]; total: number }>();

  cleanup = electronAPI.on(
    `punk-stream:${projectId}`,
    (event: PunkStreamEvent & { _chunkMeta?: { total: number; index: number; type: string; requestId: string }; _chunkData?: string }) => {
      // Ignore events tagged for a different request (e.g. a previous aborted
      // session whose processEnded arrives after the new session has started).
      if (event.requestId && event.requestId !== requestId) return;

      // ── Chunk reassembly ─────────────────────────────────────────
      // Large IPC events are split into 256KB chunks by sendToRenderer.
      // Accumulate chunks until all have arrived, then reassemble and
      // push the original event to the queue.
      if (event._chunkMeta) {
        const key = `${event._chunkMeta.requestId || requestId}:${event._chunkMeta.type}`;
        let buf = chunkBuffer.get(key);
        if (!buf) {
          buf = { chunks: new Array<string>(event._chunkMeta.total), total: event._chunkMeta.total };
          chunkBuffer.set(key, buf);
        }
        buf.chunks[event._chunkMeta.index] = event._chunkData!;

        // Check if all chunks have arrived
        if (buf.chunks.every(c => c !== undefined)) {
          chunkBuffer.delete(key);
          try {
            const reassembled = JSON.parse(buf.chunks.join('')) as PunkStreamEvent;
            queue.push(reassembled);
          } catch (err) {
            console.error('[punk] Failed to reassemble chunked event:', err);
          }
        }
      } else {
        // Normal (non-chunked) event
        queue.push(event);
      }

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
      model,
      intent: opts.intent,
      history: opts.history,
      requestId,
      thinking: opts.thinking,
      provider: opts.provider,
      todos: opts.todos,
      autoRoute: opts.autoRoute,
      powerCombo: opts.powerCombo,
      minds: opts.minds,
      phase: opts.phase,
      // Mind chat overrides — forwarded when present
      ...(opts.systemPromptOverride ? { systemPromptOverride: opts.systemPromptOverride } : {}),
      ...(opts._systemOverride ? { _systemOverride: opts._systemOverride } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    });
  } catch (err) {
    port1.close();
    port2.close();
    cleanup?.();
    throw err;
  }
}

export async function abortPunk(projectId: string): Promise<void> {
  return electronAPI.invoke("abort_punk", { projectId });
}

export interface RoutePreview {
  model: string;
  provider: string;
  tier: string;
  mode: string;
  taskType: string;
  confidence: number;
  reason: string;
}

export async function previewRoute(message: string, projectId: string): Promise<RoutePreview | null> {
  return electronAPI.invoke("preview_route", { message, projectId });
}

export async function terminatePunkSession(projectId: string): Promise<void> {
  return electronAPI.invoke("terminate_punk_session", { projectId });
}

export async function reinitializePunkBackend(backend?: string): Promise<void> {
  return electronAPI.invoke("reinitialize_punk_backend", { backend });
}

export async function getBackendAvailability(): Promise<{
  claude: boolean;
  gemini: boolean;
  api: boolean;
}> {
  return electronAPI.invoke("get_backend_availability");
}

export interface ClaudeAuthAccount {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  billingType: string | null;
  hasExtraUsageEnabled: boolean;
  subscriptionCreatedAt: string | null;
}

export interface ClaudeAuthState {
  authenticated: boolean;
  account: ClaudeAuthAccount | null;
}

/** Read Claude auth state directly from ~/.claude.json — no session needed. */
export async function getClaudeAuthState(): Promise<ClaudeAuthState> {
  return electronAPI.invoke("get_claude_auth_state");
}

/** Initiate Claude OAuth sign-in via the SDK's browser-based auth flow. */
export async function claudeSignin(): Promise<{ success: boolean; account?: Record<string, unknown>; error?: string }> {
  return electronAPI.invoke("claude_signin");
}

/** Sign out of Claude by removing oauthAccount from ~/.claude.json. */
export async function claudeSignout(): Promise<{ success: boolean }> {
  return electronAPI.invoke("claude_signout");
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

// ── SDK session management ─────────────────────────────────────────────────

export async function sdkListSessions(): Promise<unknown[]> {
  return electronAPI.invoke("sdk_list_sessions");
}

export async function sdkGetSessionMessages(sessionId: string): Promise<unknown[]> {
  return electronAPI.invoke("sdk_get_session_messages", { sessionId });
}

export async function sdkForkSession(sessionId: string): Promise<unknown> {
  return electronAPI.invoke("sdk_fork_session", { sessionId });
}

export async function refreshAllModels(): Promise<
  Record<string, OpenRouterModel[]>
> {
  return electronAPI.invoke("refresh_all_models");
}

export async function setWindowTitle(title: string): Promise<void> {
  return electronAPI.invoke("set_window_title", { title });
}

export async function getPunkPlanInfo(): Promise<string | null> {
  return electronAPI.invoke("get_claude_plan_info");
}

export interface ClaudeVersionInfo {
  current: string | null;
  error: string | null;
}

export async function checkClaudeVersion(): Promise<ClaudeVersionInfo> {
  return electronAPI.invoke("check_claude_version");
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
  return electronAPI.invoke("pane_checkpoint", {
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
): Promise<import("./punk-types").CheckpointMeta[]> {
  return electronAPI.invoke("list_checkpoints", { projectId });
}

export async function getCheckpointDiff(
  projectId: string,
  checkpointId: string,
  workingDir: string,
): Promise<{ files: CheckpointDiffFile[]; error?: string }> {
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

export async function resumeFromCheckpoint(
  projectId: string,
  sessionId: string,
): Promise<import("./punk-types").CheckpointTurn | null> {
  return electronAPI.invoke("resume_from_checkpoint", { projectId, sessionId });
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

export async function writeProjectState(
  projectId: string,
  data: ProjectState,
): Promise<void> {
  return electronAPI.invoke("write_project_state", { projectId, data });
}

export async function recordMemoryEvents(
  projectId: string,
  events: import("./punk-types").MemoryEvent[],
): Promise<void> {
  return electronAPI.invoke("record_memory_events", { projectId, events });
}

export async function generateBrief(projectId: string): Promise<string> {
  return electronAPI.invoke("generate_brief", { projectId });
}

export async function readBrief(projectId: string): Promise<string> {
  return electronAPI.invoke("read_brief", { projectId });
}

export async function getProjectAbout(projectId: string): Promise<string | null> {
  return electronAPI.invoke("get_project_about", { projectId });
}

export async function extractPreferencesFromTurn(
  turnText: string,
): Promise<void> {
  return electronAPI.invoke("brain_extract_preferences_llm", { turnText });
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
  events: import("./punk-types").MemoryEvent[],
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
  dna: string;
}

export async function brainGetProfile(): Promise<{ profile: UserProfile }> {
  return electronAPI.invoke("brain_get_profile");
}

// Updates compiled identity directly (DNA string/bio text)
export async function brainUpdateDNA(
  dna: string,
): Promise<{ updated: boolean }> {
  return electronAPI.invoke("brain_update_dna", { dna });
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
  projectId?: string,
): Promise<{ entry: MindEntry }> {
  return electronAPI.invoke("brain_mind_add", { content, projectId });
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

// --- Mind Threads ---

export interface MindThread {
  id: string;
  entry_id: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MindTurn {
  id: string;
  thread_id: string;
  role: string;
  content_json: string;
  timestamp: string;
}

export async function mindThreadCreate(
  entryId: string,
): Promise<{ thread: MindThread }> {
  return electronAPI.invoke("brain_mind_thread_create", { entryId });
}

export async function mindThreadGet(
  entryId: string,
): Promise<{ thread: MindThread | null; turns: MindTurn[] }> {
  return electronAPI.invoke("brain_mind_thread_get", { entryId });
}

export async function mindThreadListEntryIds(): Promise<{ entryIds: string[] }> {
  return electronAPI.invoke("brain_mind_thread_list_entry_ids");
}

export async function mindThreadAddTurn(
  threadId: string,
  role: string,
  contentJson: string,
): Promise<{ turn: MindTurn }> {
  return electronAPI.invoke("brain_mind_thread_add_turn", {
    threadId,
    role,
    contentJson,
  });
}

export async function mindThreadSetSession(threadId: string, sessionId: string): Promise<void> {
  return electronAPI.invoke("brain_mind_thread_set_session", { threadId, sessionId });
}

export async function mindThreadDelete(id: string): Promise<{ id: string }> {
  return electronAPI.invoke("brain_mind_thread_delete", { id });
}

// --- Lens ---

export interface LensPost {
  id: string;
  contributor: "user" | "bug" | "reflection" | "sentinel";
  content: string;
  project_id: string | null;
  entry_id: string | null;
  created_at: string;
  comment_count?: number;
}

export async function lensPostAdd(
  contributor: LensPost["contributor"],
  content: string,
  projectId: string | null,
  entryId?: string | null,
): Promise<LensPost> {
  return electronAPI.invoke("lens_post_add", { contributor, content, projectId, entryId: entryId ?? null });
}

export async function lensPostsList(projectId: string): Promise<LensPost[]> {
  return electronAPI.invoke("lens_posts_list", { projectId });
}

export async function lensPostDelete(postId: string): Promise<{ deleted: boolean }> {
  return electronAPI.invoke("lens_post_delete", { postId });
}


export interface LensComment {
  id: string;
  post_id: string;
  role: string;
  content: string;
  session_id: string | null;
  timestamp: string;
}

export async function lensCommentsList(postId: string): Promise<LensComment[]> {
  return electronAPI.invoke("lens_comments_list", { postId });
}

export async function lensCommentAdd(postId: string, role: string, content: string): Promise<LensComment> {
  return electronAPI.invoke("lens_comment_add", { postId, role, content });
}

export async function lensCommentSetSession(postId: string, sessionId: string): Promise<void> {
  return electronAPI.invoke("lens_comment_set_session", { postId, sessionId });
}

export async function abortLens(postId: string): Promise<void> {
  return electronAPI.invoke("abort_lens", { postId });
}

export async function sendToLens(
  postId: string,
  prompt: string,
  workingDir: string,
  model: string | null,
  provider: string | null,
  thinking: boolean,
  postContent: string,
  onEvent: (event: PunkStreamEvent) => void,
): Promise<void> {
  const requestId = Math.random().toString(36).slice(2, 11);
  let cleanup: (() => void) | null = null;

  const closeListener = () => {
    draining = false;
    port1.close();
    port2.close();
    setTimeout(() => cleanup?.(), 0);
  };

  const queue: PunkStreamEvent[] = [];
  let draining = false;
  const { port1, port2 } = new MessageChannel();

  port2.onmessage = () => {
    if (queue.length === 0) {
      draining = false;
      return;
    }

    const BUDGET_MS = 4;
    const deadline = performance.now() + BUDGET_MS;

    while (queue.length > 0) {
      const event = queue.shift()!;
      onEvent(event);

      const isTerminal =
        event.event === "error" || event.event === "processEnded";

      if (isTerminal) {
        closeListener();
        return;
      }

      if (performance.now() >= deadline) break;
    }

    if (queue.length > 0) port1.postMessage(null);
    else draining = false;
  };

  cleanup = electronAPI.on(
    `punk-stream:lens:${postId}`,
    (event: PunkStreamEvent) => {
      if (event.requestId && event.requestId !== requestId) return;
      queue.push(event);
      if (!draining) {
        draining = true;
        port1.postMessage(null);
      }
    },
  );

  try {
    await electronAPI.invoke("send_to_lens", {
      postId,
      prompt,
      workingDir,
      model,
      provider,
      thinking,
      requestId,
      postContent,
    });
  } catch (err) {
    port1.close();
    port2.close();
    cleanup?.();
    throw err;
  }
}

export async function sendToMind(
  threadId: string,
  prompt: string,
  workingDir: string,
  model: string | null,
  provider: string | null,
  thinking: boolean,
  entryContent: string,
  onEvent: (event: PunkStreamEvent) => void,
): Promise<void> {
  const requestId = Math.random().toString(36).slice(2, 11);
  let cleanup: (() => void) | null = null;

  const closeListener = () => {
    draining = false;
    port1.close();
    port2.close();
    setTimeout(() => cleanup?.(), 0);
  };

  const queue: PunkStreamEvent[] = [];
  let draining = false;
  const { port1, port2 } = new MessageChannel();

  port2.onmessage = () => {
    if (queue.length === 0) {
      draining = false;
      return;
    }

    const BUDGET_MS = 4;
    const deadline = performance.now() + BUDGET_MS;

    while (queue.length > 0) {
      const event = queue.shift()!;
      onEvent(event);

      const isTerminal =
        event.event === "error" || event.event === "processEnded";

      if (isTerminal) {
        closeListener();
        return;
      }

      if (performance.now() >= deadline) break;
    }

    if (queue.length > 0) port1.postMessage(null);
    else draining = false;
  };

  cleanup = electronAPI.on(
    `punk-stream:mind:${threadId}`,
    (event: PunkStreamEvent) => {
      if (event.requestId && event.requestId !== requestId) return;
      queue.push(event);
      if (!draining) {
        draining = true;
        port1.postMessage(null);
      }
    },
  );

  try {
    await electronAPI.invoke("send_to_mind", {
      threadId,
      prompt,
      workingDir,
      model,
      provider,
      thinking,
      requestId,
      entryContent,
    });
  } catch (err) {
    port1.close();
    port2.close();
    cleanup?.();
    throw err;
  }
}

export async function abortMind(threadId: string): Promise<void> {
  return electronAPI.invoke("abort_mind", { threadId });
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

// ---------------------------------------------------------------------------
// Pane Cloud
// ---------------------------------------------------------------------------

export interface CloudUser {
  github_login: string;
  github_id: number;
  avatar_url: string | null;
  logged_in: boolean;
}

export interface CloudStatus {
  last_backup: string | null;
  storage_bytes: number;
  storage_mb: number;
  backup_count: number;
}

export interface CloudBackupEntry {
  id: string;
  size_bytes: number;
  checksum: string;
  device_name: string | null;
  app_version: string | null;
  created_at: string;
}

export async function cloudLogin(): Promise<CloudUser | null> {
  return electronAPI.invoke("cloud_login");
}

export async function cloudLogout(): Promise<void> {
  return electronAPI.invoke("cloud_logout");
}

export async function cloudGetUser(): Promise<CloudUser | null> {
  return electronAPI.invoke("cloud_get_user");
}

export async function cloudGetStatus(): Promise<CloudStatus | null> {
  return electronAPI.invoke("cloud_get_status");
}

export async function cloudTriggerBackup(): Promise<{ backup_id: string; size_bytes: number }> {
  return electronAPI.invoke("cloud_trigger_backup");
}

export async function cloudRestore(): Promise<{ backup_id: string; created_at: string }> {
  return electronAPI.invoke("cloud_restore");
}

export async function cloudListBackups(): Promise<{ backups: CloudBackupEntry[] }> {
  return electronAPI.invoke("cloud_list_backups");
}

// Theme-aware dock icon — switches between default/glass/dark variants
export function setAppTheme(theme: string): void {
  electronAPI.invoke("set_app_theme", { theme }).catch(() => {});
}

// ── Punk Review System ──────────────────────────────────────────────────────

export interface ReviewFinding {
  id: string;
  session_id: string;
  project_id: string;
  punk: string;
  severity: "critical" | "warning" | "note";
  finding: string;
  structured: string;
  location: string | null;
  remediation: string | null;
  created_at: string;
}

export interface ReviewSession {
  id: string;
  project_id: string;
  status: "running" | "completed" | "failed";
  diff_summary: string | null;
  base_ref: string | null;
  punk_count: number;
  finding_count: number;
  created_at: string;
  completed_at: string | null;
}

export async function runReview(projectId: string, workingDir: string): Promise<{ started: boolean }> {
  return electronAPI.invoke("run_review", { projectId, workingDir });
}

export async function reviewFindingsList(sessionId: string): Promise<{ findings: ReviewFinding[] }> {
  return electronAPI.invoke("review_findings_list", { sessionId });
}

export async function reviewSessionsList(projectId: string): Promise<{ sessions: ReviewSession[] }> {
  return electronAPI.invoke("review_sessions_list", { projectId });
}

export async function reviewSessionLatest(projectId: string): Promise<{ session: ReviewSession | null; findings: ReviewFinding[] }> {
  return electronAPI.invoke("review_session_latest", { projectId });
}

// ── Lens v2: Single Punk Execution ───────────────────────────────────────

/**
 * Run a single punk (ash, ghost, sage) on demand.
 * Results arrive via pane://punk-progress and pane://punk-complete events.
 */
export async function runSinglePunk(
  punkName: string,
  projectId: string,
  workingDir: string,
  scope?: string | null,
): Promise<{ started: boolean }> {
  return electronAPI.invoke("run_single_punk", { punkName, projectId, workingDir, scope });
}

/**
 * Re-check a punk's previous findings against the current codebase.
 * Results arrive via pane://punk-progress and pane://punk-complete events.
 */
export async function checkPreviousFindings(
  punkName: string,
  projectId: string,
  workingDir: string,
): Promise<{ started: boolean }> {
  return electronAPI.invoke("check_previous_findings", { punkName, projectId, workingDir });
}

// ── Lens v2: Finding Queries ─────────────────────────────────────────────

export async function findingsList(
  projectId: string,
  limit?: number,
): Promise<{ findings: ReviewFinding[] }> {
  return electronAPI.invoke("findings_list", { projectId, limit });
}

export async function findingsByPunk(
  punkName: string,
  projectId: string,
  limit?: number,
): Promise<{ findings: ReviewFinding[] }> {
  return electronAPI.invoke("findings_by_punk", { projectId, punkName, limit });
}

export async function dismissFinding(
  findingId: string,
): Promise<{ success: boolean }> {
  return electronAPI.invoke("dismiss_finding", { findingId });
}

// ── Punk Management ──────────────────────────────────────────────────────

/** List all available punks from disk with metadata (name, displayName, role). */
export async function listPunks(): Promise<Array<{ name: string; displayName: string; role: string }>> {
  return electronAPI.invoke("list_punks");
}

/** Create a new punk persona file on disk. */
export async function createPunk(
  name: string,
  personaContent: string,
): Promise<{ success: boolean; error?: string }> {
  return electronAPI.invoke("create_punk", { name, personaContent });
}

// ── Thread State ─────────────────────────────────────────────────────────
// Prompt/response activity data used for the thread list UI.

export async function recordLastPrompt(projectId: string, promptText: string, promptHash: number): Promise<void> {
  return electronAPI.invoke("record_last_prompt", { projectId, promptText, promptHash });
}

export async function recordLastResponse(projectId: string, summary: string): Promise<void> {
  return electronAPI.invoke("record_last_response", { projectId, summary });
}

export async function getThreadState(projectId: string): Promise<Record<string, unknown> | null> {
  return electronAPI.invoke("get_thread_state", { projectId });
}

export async function getAllThreadStates(projectIds: string[]): Promise<Record<string, unknown>> {
  return electronAPI.invoke("get_all_thread_states", { projectIds });
}

/**
 * Respond to a suspended tool call (plan approval or AskUserQuestion).
 * Resolves the pending Promise in the backend, unblocking the model loop.
 */
export async function respondToTool(
  projectId: string,
  toolId: string,
  response: string,
): Promise<boolean> {
  return electronAPI.invoke("punk:respond-to-tool", { projectId, toolId, response });
}
