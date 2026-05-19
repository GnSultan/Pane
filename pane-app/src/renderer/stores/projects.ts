import { create } from "zustand";
import type { FileEntry } from "../lib/tauri-commands";
import type {
  ConversationState,
  Conversation,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
  CheckpointMeta,
  ArbiterVerdict,
} from "../lib/punk-types";
import { createEmptyConversation, createEmptyConversationMeta } from "../lib/punk-types";
import type { PowerCombo } from "../lib/models";
import { DEFAULT_POWER_COMBO } from "../lib/models";
import { useWorkspaceStore } from "./workspace";

// Maximum messages kept in-memory per conversation. Full history lives in
// SQLite — the store is a display-only cache. With virtual scrolling, only
// ~20-30 messages are rendered as DOM at any time, so 100 in the store is
// more than sufficient — old messages are trimmed from the front and the
// "load older" button fetches them from disk.
const MAX_STORE_MESSAGES = 100;

export interface ProjectGit {
  branch: string | null;
  fileStatuses: Map<string, string>;
  dirtyDirs: Set<string>; // pre-computed: all ancestor dirs of changed files
  isGitRepo: boolean;
}

export interface ProjectFileIndex {
  files: string[];
  lastIndexed: number;
  isLoading: boolean;
}

export interface TerminalTab {
  id: string; // doubles as ptyId
  title: string; // display label (path)
  isAlive: boolean; // false after PTY exit
  cwd?: string; // current working directory, updated as user navigates
}

export interface Project {
  id: string;
  root: string;
  name: string;
  rootMissing?: boolean; // true when the folder no longer exists at the stored path
  expandedDirs: Set<string>;
  dirContents: Map<string, FileEntry[]>;
  loadingDirs: Set<string>;
  selectedPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
  mode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";
  conversation: ConversationState; // Backward compat — reads from active conversation
  conversations: Map<string, Conversation>; // id → Conversation
  activeConversationId: string | null;
  conversationOrder: string[]; // ordered tab list
  git: ProjectGit;
  fileIndex: ProjectFileIndex;
  hasUnreadCompletion: boolean; // true when background task completes, cleared when project becomes active
  hasUnreadLens: boolean; // true when a new Lens post/punk finding arrives while Lens is not open
  recentFiles: string[]; // last 20 opened files (FIFO)
  terminalTabs: TerminalTab[];
  activeTerminalTabId: string | null;
  checkpoints: CheckpointMeta[];
  scrollPositions: Map<string, { scrollTop: number; cursor: { row: number; column: number } }>;
  /** Per-project power combo: which model serves each phase (think/build).
   *  When set, overrides the global workspace powerCombo for this project.
   *  Undefined means "use workspace default". */
  powerCombo?: PowerCombo;
  /** Per-project auto-route toggle. Undefined means "use workspace default". */
  autoEscalate?: boolean;
  /** Per-project explicit model pin. When set, this project always uses
   *  this model when auto-route is off, regardless of workspace default.
   *  Undefined means "use workspace default selectedModel". */
  selectedModel?: string;
  /** Per-project model provider. Undefined means "use workspace default". */
  selectedModelProvider?: string;
  /** Per-project thinking override. Undefined means "use workspace default". */
  selectedModelThinking?: boolean;
  /** Last user prompt text (max 500 chars) — for thread list preview. */
  lastUserPromptText: string | null;
  /** Last response summary (max 200 chars) — for thread list preview. */
  lastResponseSummary: string | null;
  /** Epoch ms of last user or model activity — for thread list sorting. */
  lastActivityAt: number | null;
  /** When true, this thread is archived — hidden from main list, visible
   *  in a collapsible "Archived" section. Migrates to conversation-level
   *  is_archived when multi-conversation (Phase 0) lands. */
  archived?: boolean;
  /** Temporary override for streaming routing. When set, getActiveConv /
   *  updateActiveConv target this conversation instead of activeConversationId.
   *  Prevents streaming text from one conversation leaking into another when
   *  the user switches tabs mid-stream. Set by usePunk.ts at stream start,
   *  cleared when streaming finishes. */
  streamingConvId?: string;
}

/**
 * Generate a stable project ID.
 * New projects get a UUID. Existing projects pass their stored ID so all
 * memory/SQLite data (keyed on the old derived ID) stays intact.
 */
function generateProjectId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProject(root: string, stableId?: string): Project {
  const name = root.split("/").filter(Boolean).pop() || root;
  const id = stableId ?? generateProjectId();

  // When restoring from settings (stableId provided), skip the default conversation.
  // DB hydration will populate it. For fresh projects (no stableId), create a default "main" conv.
  const hasDefaultConv = !stableId;
  const defaultConvId = hasDefaultConv ? crypto.randomUUID() : null;
  const defaultConv = hasDefaultConv && defaultConvId ? createEmptyConversationMeta(defaultConvId, "Conversation") : null;

  return {
    id,
    root,
    name,
    expandedDirs: new Set(),
    dirContents: new Map(),
    loadingDirs: new Set(),
    selectedPath: null,
    activeFilePath: null,
    activeFileContent: null,
    mode: "conversation",
    conversation: defaultConv?.state ?? createEmptyConversation(),
    conversations: defaultConv ? new Map([[defaultConvId!, defaultConv]]) : new Map(),
    activeConversationId: defaultConvId,
    conversationOrder: defaultConvId ? [defaultConvId] : [],
    git: {
      branch: null,
      fileStatuses: new Map(),
      dirtyDirs: new Set(),
      isGitRepo: false,
    },
    fileIndex: { files: [], lastIndexed: 0, isLoading: false },
    hasUnreadCompletion: false,
    hasUnreadLens: false,
    recentFiles: [],
    terminalTabs: [],
    activeTerminalTabId: null,
    checkpoints: [],
    scrollPositions: new Map(),
    lastUserPromptText: null,
    lastResponseSummary: null,
    lastActivityAt: null,
  };
}

// Ensure unique IDs — UUIDs won't collide but derived IDs from old projects might
function ensureUniqueId(id: string, existing: Map<string, Project>): string {
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

interface ProjectsState {
  projects: Map<string, Project>;
  activeProjectId: string | null;
  projectOrder: string[]; // ordered list of project IDs for Cmd+1/2/3

  // Project lifecycle
  addProject: (root: string, stableId?: string) => string; // returns project ID
  removeProject: (id: string) => void;
  archiveProject: (id: string) => void;
  restoreProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  rebindProject: (id: string, newRoot: string) => void; // update root binding after folder move/rename
  markRootMissing: (id: string, missing: boolean) => void;
  migrateProjectId: (oldId: string, newId: string) => void; // swap store entry from old derived ID to UUID
  setActiveProject: (id: string) => void;

  // Active project helpers
  getActiveProject: () => Project | undefined;

  // Per-project file tree
  toggleDir: (projectId: string, path: string) => void;
  setDirContents: (
    projectId: string,
    path: string,
    entries: FileEntry[],
  ) => void;
  batchSetDirContents: (
    projectId: string,
    tree: Record<string, FileEntry[]>,
  ) => void;
  setLoading: (projectId: string, path: string, loading: boolean) => void;
  setSelectedPath: (projectId: string, path: string | null) => void;

  // Per-project file viewer
  openFile: (projectId: string, path: string, content: string) => void;
  updateFileContent: (projectId: string, content: string) => void;
  clearFile: (projectId: string) => void;
  setScrollPosition: (
    projectId: string,
    path: string,
    pos: { scrollTop: number; cursor: { row: number; column: number } },
  ) => void;

  // Per-project mode
  setMode: (
    projectId: string,
    mode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch",
  ) => void;
  toggleMode: (projectId: string) => void;

  // Project ordering
  reorderProjects: (fromIndex: number, toIndex: number) => void;

  // Per-project git
  setGitStatus: (
    projectId: string,
    branch: string,
    fileStatuses: Map<string, string>,
    isGitRepo: boolean,
  ) => void;

  // Per-project file index
  setFileIndex: (projectId: string, files: string[]) => void;
  setFileIndexLoading: (projectId: string, loading: boolean) => void;
  invalidateFileIndex: (projectId: string) => void;

  // Per-project conversation
  // Multi-conversation lifecycle
  addConversation: (projectId: string, label?: string, phase?: import("../lib/punk-types").PanePhase) => string;
  removeConversation: (projectId: string, conversationId: string) => void;
  archiveConversation: (projectId: string, conversationId: string) => void;
  unarchiveConversation: (projectId: string, conversationId: string) => void;
  setActiveConversation: (projectId: string, conversationId: string | null) => void;
  closeConversationTab: (projectId: string, conversationId: string) => void;
  renameConversation: (projectId: string, conversationId: string, label: string) => void;

  addConversationMessage: (
    projectId: string,
    message: ConversationMessage,
  ) => void;
  removeLastConversationMessage: (projectId: string) => void;
  removeConversationMessageById: (projectId: string, messageId: string) => void;
  updateMessageContent: (
    projectId: string,
    messageId: string,
    content: ContentBlock[],
  ) => void;
  updateMessageReasoning: (
    projectId: string,
    messageId: string,
    reasoning: string,
  ) => void;
  updateLastAssistantContent: (
    projectId: string,
    content: ContentBlock[],
  ) => void;  appendToLastAssistantText: (projectId: string, text: string) => void;
  appendToLastAssistantThinking: (projectId: string, thinking: string) => void;
  setLastThinkingSignature: (projectId: string, signature: string) => void;
  setConversationModel: (projectId: string, model: string) => void;
  setConversationStatusMessage: (
    projectId: string,
    message: string | null,
  ) => void;
  setConversationRoutedModel: (projectId: string, model: string | null) => void;
  setConversationRestored: (projectId: string, isRestored: boolean) => void;
  setConversationProcessing: (projectId: string, isProcessing: boolean) => void;
  setConversationError: (projectId: string, error: string | null) => void;
  setLastMessageStreamingDone: (projectId: string) => void;
  finalizeAllStreaming: (projectId: string) => void;
  setLastAssistantMeta: (
    projectId: string,
    costUsd: number,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    numTurns?: number,
  ) => void;
  setLastAssistantVerdict: (projectId: string, verdict: ArbiterVerdict) => void;
  clearConversation: (projectId: string) => void;
  clearSessionContext: (projectId: string) => void;
  setHasUnreadCompletion: (projectId: string, hasUnread: boolean) => void;
  setHasUnreadLens: (projectId: string, hasUnread: boolean) => void;
  restoreConversation: (
    projectId: string,
    messages: ConversationMessage[],
    historyInfo?: { totalCount: number; startIndex: number },
    conversationId?: string,
  ) => void;
  prependOlderMessages: (
    projectId: string,
    messages: ConversationMessage[],
    newStartIndex: number,
    conversationId?: string,
  ) => void;
  setConversationTodos: (
    projectId: string,
    todos: import("../lib/punk-types").Todo[],
  ) => void;
  setPendingInput: (projectId: string, pendingInput: import("../lib/punk-types").ConversationState["pendingInput"]) => void;
  clearPendingInput: (projectId: string) => void;
  setIsPlanning: (projectId: string, isPlanning: boolean) => void;
  setConversationPhase: (projectId: string, phase: import("../lib/punk-types").ConversationState["phase"]) => void;
  /** Set a temporary streaming conversation override — routes all getActiveConv /
   *  updateActiveConv calls to this conversation instead of activeConversationId.
   *  Pass null to clear. Prevents cross-conversation streaming leaks. */
  setStreamingConvId: (projectId: string, conversationId: string | null) => void;
  updateLastToolUseInput: (
    projectId: string,
    input: Record<string, unknown>,
  ) => void;
  /** Directly update a specific conversation's state, bypassing streamingConvId routing.
   *  Used by handlePunkMessage and streaming flush functions to write to the correct
   *  conversation when multiple conversations may be streaming simultaneously. */
  updateConversation: (
    projectId: string,
    conversationId: string,
    partial: Partial<ConversationState>,
  ) => void;
  updateToolUseInputById: (
    projectId: string,
    toolId: string,
    input: Record<string, unknown>,
  ) => void;
  setContextPressure: (
    projectId: string,
    tokens: number,
    pressure: import("../lib/punk-types").ContextPressure,
  ) => void;
  setCompactionStatus: (
    projectId: string,
    status: { isCompacting?: boolean; lastCompactionAt?: number; compactionCount?: number; tokensSaved?: number },
  ) => void;
  setCachedBrief: (projectId: string, brief: string) => void;

  // Terminal tabs
  addTerminalTab: (projectId: string, tab: TerminalTab) => void;
  removeTerminalTab: (projectId: string, tabId: string) => void;
  setActiveTerminalTab: (projectId: string, tabId: string) => void;
  markTerminalTabDead: (projectId: string, tabId: string) => void;
  updateTerminalTabCwd: (projectId: string, tabId: string, cwd: string) => void;

  // Per-project routing
  setProjectPowerCombo: (projectId: string, combo: PowerCombo) => void;
  setProjectAutoEscalate: (projectId: string, autoEscalate: boolean) => void;
  setProjectSelectedModel: (projectId: string, model: string, thinking: boolean, provider?: string) => void;
  getProjectEffectiveCombo: (projectId: string) => PowerCombo;
  // Thread list activity
  setThreadActivity: (projectId: string, fields: { lastUserPromptText?: string | null; lastResponseSummary?: string | null; lastActivityAt?: number | null }) => void;

  // Checkpoints
  addCheckpoint: (projectId: string, meta: CheckpointMeta) => void;
  setCheckpoints: (projectId: string, checkpoints: CheckpointMeta[]) => void;
  clearCheckpoints: (projectId: string) => void;
}

function updateProject(
  state: ProjectsState,
  projectId: string,
  updater: (project: Project) => Partial<Project>,
): Partial<ProjectsState> {
  const project = state.projects.get(projectId);
  if (!project) return {};
  const updates = updater(project);
  const next = new Map(state.projects);
  next.set(projectId, { ...project, ...updates });
  return { projects: next };
}

// ── Multi-conversation helpers ───────────────────────────────────────────
// These helper functions handle reading/writing the active conversation's state
// while dual-writing to both the backward compat `conversation` field and the
// new `conversations` Map. Existing selectors reading `project.conversation.X`
// continue to work unchanged during the transition.

function getActiveConv(project: Project): ConversationState {
  const targetId = project.streamingConvId ?? project.activeConversationId;
  if (!targetId) return createEmptyConversation();
  const conv = project.conversations.get(targetId);
  return conv?.state ?? createEmptyConversation();
}

function updateActiveConv(
  project: Project,
  partial: Partial<ConversationState>,
): { conversation?: ConversationState; conversations: Map<string, Conversation> } {
  const targetId = project.streamingConvId ?? project.activeConversationId;
  if (!targetId) {
    const newState = { ...createEmptyConversation(), ...partial };
    return { conversation: newState, conversations: project.conversations };
  }
  const conv = project.conversations.get(targetId);
  if (!conv) {
    const newState = { ...createEmptyConversation(), ...partial };
    return { conversation: newState, conversations: project.conversations };
  }
  const updated: Conversation = {
    ...conv,
    state: { ...conv.state, ...partial },
    updatedAt: Date.now(),
  };
  const next = new Map(project.conversations);
  next.set(targetId, updated);
  // Always update the backward-compat conversation field to reflect the
  // conversation being mutated (streaming or active). This prevents
  // cross-contamination when code reads project.conversation directly
  // during streaming — e.g., handlePunkMessage, InputBar, MessageBubble.
  return { conversation: updated.state, conversations: next };
}

/** Directly update a specific conversation's state, bypassing streamingConvId routing.
 *  Unlike updateActiveConv which resolves through streamingConvId, this targets the
 *  exact conversationId given. Used by streaming code to prevent cross-contamination
 *  when multiple conversations stream simultaneously. */
function directUpdateConv(
  project: Project,
  conversationId: string,
  partial: Partial<ConversationState>,
): { conversation?: ConversationState; conversations: Map<string, Conversation> } {
  const conv = project.conversations.get(conversationId);
  if (!conv) {
    const newState = { ...createEmptyConversation(), ...partial };
    return { conversation: newState, conversations: project.conversations };
  }
  const updated: Conversation = {
    ...conv,
    state: { ...conv.state, ...partial },
    updatedAt: Date.now(),
  };
  const next = new Map(project.conversations);
  next.set(conversationId, updated);
  return { conversation: updated.state, conversations: next };
}

function createProjectsStore() {
  return create<ProjectsState>()((set, get) => ({
    projects: new Map(),
    activeProjectId: null,
    projectOrder: [],

    addProject: (root: string, stableId?: string) => {
      const state = get();
      // Don't add duplicate roots — return existing project ID
      for (const p of state.projects.values()) {
        if (p.root === root) {
          set({ activeProjectId: p.id });
          return p.id;
        }
      }
      // If a stableId is provided and already exists (e.g. from a previous session),
      // trust it — don't ensureUnique since it IS the canonical identity.
      const project = createProject(root, stableId);
      if (!stableId) {
        project.id = ensureUniqueId(project.id, state.projects);
      }
      // Seed thread activity timestamp so newly added projects sort to top
      project.lastActivityAt = Date.now();
      const next = new Map(state.projects);
      next.set(project.id, project);
      set({
        projects: next,
        activeProjectId: project.id,
        projectOrder: [...state.projectOrder, project.id],
      });
      return project.id;
    },

    renameProject: (id: string, name: string) => {
      set((state) => updateProject(state, id, () => ({ name: name.trim() || state.projects.get(id)?.name || "" })));
    },

    rebindProject: (id: string, newRoot: string) => {
      set((state) =>
        updateProject(state, id, () => ({
          root: newRoot,
          name: newRoot.split("/").filter(Boolean).pop() || newRoot,
          rootMissing: false,
        }))
      );
    },

    markRootMissing: (id: string, missing: boolean) => {
      set((state) => updateProject(state, id, () => ({ rootMissing: missing })));
    },

    migrateProjectId: (oldId: string, newId: string) => {
      set((state) => {
        const project = state.projects.get(oldId);
        if (!project) return {}; // already migrated or doesn't exist
        const next = new Map(state.projects);
        next.delete(oldId);
        next.set(newId, { ...project, id: newId });
        const nextOrder = state.projectOrder.map((pid) => (pid === oldId ? newId : pid));
        const nextActive = state.activeProjectId === oldId ? newId : state.activeProjectId;
        return { projects: next, projectOrder: nextOrder, activeProjectId: nextActive };
      });
    },

    removeProject: (id: string) => {
      const state = get();
      const next = new Map(state.projects);
      next.delete(id);
      const nextOrder = state.projectOrder.filter((pid) => pid !== id);
      const nextActive =
        state.activeProjectId === id
          ? nextOrder[0] || null
          : state.activeProjectId;
      set({
        projects: next,
        activeProjectId: nextActive,
        projectOrder: nextOrder,
      });
    },

    archiveProject: (id: string) => {
      set((state) => {
        const project = state.projects.get(id);
        if (!project) return {};

        // If archiving the active project, switch to the next non-archived
        let nextActive = state.activeProjectId;
        if (state.activeProjectId === id) {
          const candidates = state.projectOrder.filter(
            (pid) => pid !== id && !state.projects.get(pid)?.archived,
          );
          nextActive = candidates[0] || null;
        }

        return {
          ...updateProject(state, id, () => ({ archived: true })),
          activeProjectId: nextActive,
        };
      });
    },

    restoreProject: (id: string) => {
      set((state) => updateProject(state, id, () => ({ archived: false })));
    },

    setActiveProject: (id: string) => {
      set((state) => {
        const project = state.projects.get(id);
        if (!project) return { activeProjectId: id };

        // Carry the current workspace mode to the target project so switching
        // threads while in file explorer (or terminal, etc.) stays locked there.
        const currentProject = state.activeProjectId
          ? state.projects.get(state.activeProjectId)
          : undefined;
        const carryMode = currentProject?.mode;
        const isTransientMode = carryMode === "mind" || carryMode === "profile" || carryMode === "history" || carryMode === "lens";

        const updatedProjects = new Map(state.projects);
        const updatedProject = {
          ...project,
          hasUnreadCompletion: false,
          ...(carryMode && !isTransientMode ? { mode: carryMode } : {}),
        };
        updatedProjects.set(id, updatedProject);
        return { activeProjectId: id, projects: updatedProjects };
      });
    },

    getActiveProject: () => {
      const state = get();
      if (!state.activeProjectId) return undefined;
      return state.projects.get(state.activeProjectId);
    },

    // File tree
    toggleDir: (projectId, path) =>
      set((state) => {
        const project = state.projects.get(projectId);
        if (!project) return {};
        const next = new Set(project.expandedDirs);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        const projects = new Map(state.projects);
        projects.set(projectId, { ...project, expandedDirs: next });
        return { projects };
      }),

    setDirContents: (projectId, path, entries) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.dirContents);
          next.set(path, entries);
          return { dirContents: next };
        }),
      ),

    batchSetDirContents: (projectId, tree) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.dirContents);
          for (const [dir, entries] of Object.entries(tree)) {
            next.set(dir, entries);
          }
          return { dirContents: next };
        }),
      ),

    setLoading: (projectId, path, loading) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Set(p.loadingDirs);
          if (loading) next.add(path);
          else next.delete(path);
          return { loadingDirs: next };
        }),
      ),

    setSelectedPath: (projectId, path) =>
      set((state) =>
        updateProject(state, projectId, () => ({ selectedPath: path })),
      ),

    // File viewer
    openFile: (projectId, path, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const recent = [
            path,
            ...p.recentFiles.filter((f) => f !== path),
          ].slice(0, 20);
          return {
            activeFilePath: path,
            activeFileContent: content,
            mode: "viewer" as const,
            recentFiles: recent,
          };
        }),
      ),

    updateFileContent: (projectId, content) =>
      set((state) =>
        updateProject(state, projectId, () => ({ activeFileContent: content })),
      ),

    clearFile: (projectId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          activeFilePath: null,
          activeFileContent: null,
        })),
      ),

    setScrollPosition: (projectId, path, pos) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.scrollPositions);
          next.set(path, pos);
          return { scrollPositions: next };
        }),
      ),

    // Mode
    setMode: (projectId, mode) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          mode,
          // Opening Lens clears the unread badge
          ...(mode === "lens" ? { hasUnreadLens: false } : {}),
        })),
      ),

    toggleMode: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          // Toggle between Chat and Viewer (file explorer / directory browser)
          let nextMode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";
          if (p.mode === "conversation") {
            nextMode = "viewer";
          } else {
            // From git, terminal, viewer, mind, profile, history, lens, fuzzy, or search — always go back to conversation
            nextMode = "conversation";
          }
          return { mode: nextMode };
        }),
      ),

    reorderProjects: (fromIndex, toIndex) =>
      set((state) => {
        const next = [...state.projectOrder];
        const [moved] = next.splice(fromIndex, 1) as [string];
        next.splice(toIndex, 0, moved);
        return { projectOrder: next };
      }),

    // Git
    setGitStatus: (projectId, branch, fileStatuses, isGitRepo) =>
      set((state) =>
        updateProject(state, projectId, () => {
          // Pre-compute set of all ancestor directories that contain changes
          const dirtyDirs = new Set<string>();
          for (const filePath of fileStatuses.keys()) {
            let dir = filePath;
            while (true) {
              const slash = dir.lastIndexOf("/");
              if (slash <= 0) break;
              dir = dir.slice(0, slash);
              if (dirtyDirs.has(dir)) break; // ancestors already added
              dirtyDirs.add(dir);
            }
          }
          return { git: { branch, fileStatuses, dirtyDirs, isGitRepo } };
        }),
      ),

    // File index
    setFileIndex: (projectId, files) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: {
            ...p.fileIndex,
            files,
            lastIndexed: Date.now(),
            isLoading: false,
          },
        })),
      ),

    setFileIndexLoading: (projectId, loading) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: { ...p.fileIndex, isLoading: loading },
        })),
      ),

    invalidateFileIndex: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: { ...p.fileIndex, lastIndexed: 0 },
        })),
      ),

    // ── Multi-conversation lifecycle ──────────────────────────────────────
    addConversation: (projectId, label?: string, phase: import("../lib/punk-types").PanePhase = "idle") => {
      const convId = crypto.randomUUID();
      // Auto-generate a label that doesn't conflict with existing labels.
      // Finds the highest "Conversation N" number among non-archived conversations
      // and increments, avoiding the count-based approach which can create duplicates
      // when conversations have been renamed.
      const convLabel = label ?? (() => {
        const p = useProjectsStore.getState().projects.get(projectId);
        const existing = p ? [...p.conversations.values()].filter((c) => !c.isArchived) : [];
        const existingLabels = new Set(existing.map((c) => c.label.toLowerCase()));
        // Find the highest "Conversation N" number
        let maxN = 0;
        for (const c of existing) {
          const match = c.label.match(/^Conversation (\d+)$/i);
          if (match) maxN = Math.max(maxN, parseInt(match[1]!, 10));
        }
        // Increment until we find an unused label
        let n = maxN + 1;
        let candidate = `Conversation ${n}`;
        while (existingLabels.has(candidate.toLowerCase())) {
          n++;
          candidate = `Conversation ${n}`;
        }
        return candidate;
      })();
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = createEmptyConversationMeta(convId, convLabel);
          conv.phase = phase;
          const next = new Map(p.conversations);
          next.set(convId, conv);
          return {
            conversations: next,
            conversationOrder: [...p.conversationOrder, convId],
          };
        }),
      );
      // Delegate to setActiveConversation to clean up the previous empty
      // active conversation (if any) and set the new one as active.
      get().setActiveConversation(projectId, convId);
      return convId;
    },

    removeConversation: (projectId, conversationId) => {
      // Persist deletion to DB (fire-and-forget). The IPC handler deletes
      // both messages and the conversation row in a transaction.
      import("../lib/tauri-commands").then(({ deleteConversation }) => {
        deleteConversation(conversationId).catch(() => {});
      });
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = p.conversations.get(conversationId);
          if (!conv) return {};

          // Prevent removing the last non-archived conversation — would cause blank UI.
          const nonArchivedCount = Array.from(p.conversations.values()).filter(
            (c) => c.id !== conversationId && !c.isArchived,
          ).length;
          if (nonArchivedCount === 0) return {}; // Can't remove the last one

          const next = new Map(p.conversations);
          next.delete(conversationId);
          const nextOrder = p.conversationOrder.filter((id) => id !== conversationId);
          let nextActive = p.activeConversationId;
          if (nextActive === conversationId) {
            nextActive = nextOrder[0] || null;
          }
          const activeConv = nextActive ? next.get(nextActive) : null;
          return {
            conversations: next,
            conversationOrder: nextOrder,
            activeConversationId: nextActive,
            conversation: activeConv?.state ?? createEmptyConversation(),
          };
        }),
      );
    },

    archiveConversation: (projectId, conversationId) => {
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = p.conversations.get(conversationId);
          if (!conv) return {};

          // Prevent archiving the last non-archived conversation — would cause blank UI.
          const nonArchivedCount = Array.from(p.conversations.values()).filter(
            (c) => c.id !== conversationId && !c.isArchived,
          ).length;
          if (nonArchivedCount === 0) return {}; // Can't archive the last one

          const updated: Conversation = { ...conv, isArchived: true, updatedAt: Date.now() };
          const next = new Map(p.conversations);
          next.set(conversationId, updated);

          // Remove from conversationOrder (archived → not in tabs)
          const nextOrder = p.conversationOrder.filter((id) => id !== conversationId);

          // If archiving the active conversation, switch to the next non-archived
          let nextActive = p.activeConversationId;
          if (nextActive === conversationId) {
            const candidate = p.conversationOrder.find(
              (id) => id !== conversationId && !next.get(id)?.isArchived,
            );
            nextActive = candidate || null;
          }
          const activeConv = nextActive ? next.get(nextActive) : null;
          return {
            conversations: next,
            conversationOrder: nextOrder,
            activeConversationId: nextActive,
            conversation: activeConv?.state ?? createEmptyConversation(),
          };
        }),
      );
      // Persist to DB asynchronously
      import("../lib/tauri-commands").then(({ archiveConversation }) => {
        archiveConversation(conversationId).catch((err) =>
          console.error("[projects] Failed to persist archive:", err.message),
        );
      });
    },

    unarchiveConversation: (projectId, conversationId) => {
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = p.conversations.get(conversationId);
          if (!conv) return {};
          const updated: Conversation = { ...conv, isArchived: false, updatedAt: Date.now() };
          const next = new Map(p.conversations);
          next.set(conversationId, updated);
          // Ensure it's in conversationOrder
          const nextOrder = p.conversationOrder.includes(conversationId)
            ? p.conversationOrder
            : [...p.conversationOrder, conversationId];
          return {
            conversations: next,
            conversationOrder: nextOrder,
          };
        }),
      );
      // Persist to DB asynchronously
      import("../lib/tauri-commands").then((mod) => {
        mod.restoreConversation(conversationId).catch((err) =>
          console.error("[projects] Failed to persist restore:", err.message),
        );
      });
    },

    setActiveConversation: (projectId, conversationId) => {
      set((state) =>
        updateProject(state, projectId, (p) => {
          let conversations = p.conversations;
          let order = p.conversationOrder;

          // Auto-remove the previous active conversation if it's empty (0 messages)
          const prevActiveId = p.activeConversationId;
          if (prevActiveId && prevActiveId !== conversationId) {
            const prevConv = p.conversations.get(prevActiveId);
            if (prevConv && prevConv.state.messages.length === 0) {
              conversations = new Map(p.conversations);
              conversations.delete(prevActiveId);
              order = p.conversationOrder.filter((id) => id !== prevActiveId);
              // Persist deletion to DB
              import("../lib/tauri-commands").then(({ deleteConversation }) => {
                deleteConversation(prevActiveId).catch(() => {});
              });
            }
          }

          // If conversationId is null, this is navigation to the picker
          if (!conversationId) {
            return {
              activeConversationId: null,
              conversations,
              conversationOrder: order,
            };
          }

          const conv = p.conversations.get(conversationId);
          if (!conv) return { conversations, conversationOrder: order };

          // Add to conversationOrder if not already there (opening a tab)
          if (!order.includes(conversationId)) {
            order = [...order, conversationId];
          }

          // Bump updatedAt
          const updated: Conversation = { ...conv, updatedAt: Date.now() };
          const next = new Map(conversations);
          next.set(conversationId, updated);
          return {
            activeConversationId: conversationId,
            conversation: p.streamingConvId ? p.conversation : updated.state,
            conversations: next,
            conversationOrder: order,
          };
        }),
      );
    },

    closeConversationTab: (projectId, conversationId) => {
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = p.conversations.get(conversationId);
          if (!conv) return {};

          // Just remove from conversationOrder (close tab) but keep in conversations Map
          const nextOrder = p.conversationOrder.filter((id) => id !== conversationId);

          // If closing the active tab, switch to another
          let nextActive = p.activeConversationId;
          if (nextActive === conversationId) {
            nextActive = nextOrder[0] || null;
          }

          const activeConv = nextActive ? p.conversations.get(nextActive) : null;
          return {
            conversationOrder: nextOrder,
            activeConversationId: nextActive,
            conversation: p.streamingConvId ? p.conversation : (activeConv?.state ?? createEmptyConversation()),
          };
        }),
      );
    },

    renameConversation: (projectId, conversationId, label) => {
      const trimmed = label.trim();
      if (!trimmed) return; // Empty label — no-op

      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = p.conversations.get(conversationId);
          if (!conv) return {};

          // WEAK-2: Reject duplicate labels (case-insensitive) against other non-archived conversations
          const isDuplicate = Array.from(p.conversations.values()).some(
            (c) => c.id !== conversationId && !c.isArchived && c.label.toLowerCase() === trimmed.toLowerCase(),
          );
          if (isDuplicate) return {}; // Silently reject duplicate label

          const updated: Conversation = {
            ...conv,
            label: trimmed || conv.label,
            updatedAt: Date.now(),
          };
          const next = new Map(p.conversations);
          next.set(conversationId, updated);
          const isActive = p.activeConversationId === conversationId;
          return {
            conversations: next,
            conversation: isActive ? updated.state : p.conversation,
          };
        }),
      );
    },

    // ── Conversation ────────────────────────────────────────────────────
    addConversationMessage: (projectId, message) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          if (conv.messages.some((m) => m.id === message.id)) return {};

          // Adaptive naming: update the conversation label on every user message.
          // The label reflects the latest subject, helping the user identify which
          // conversation to resume even after the topic shifts.
          const convMeta = p.activeConversationId ? p.conversations.get(p.activeConversationId) : null;
          let labelOverride: string | null = null;
          if (message.type === "user") {
            const textBlock = (message.content ?? []).find(
              (b): b is { type: "text"; text: string } => b.type === "text",
            );
            if (textBlock?.text) {
              labelOverride = textBlock.text.replace(/\s+/g, " ").trim().slice(0, 60);
            }
          }

          const messages = [...conv.messages, message];
          const capped = messages.length > MAX_STORE_MESSAGES
            ? messages.slice(messages.length - MAX_STORE_MESSAGES)
            : messages;

          // If auto-labeling, update both the conversations map and active conv state
          if (labelOverride && convMeta) {
            const updatedConv: Conversation = {
              ...convMeta,
              label: labelOverride,
              state: { ...convMeta.state, messages: capped },
              updatedAt: Date.now(),
            };
            const nextConvs = new Map(p.conversations);
            nextConvs.set(convMeta.id, updatedConv);
            return {
              conversations: nextConvs,
              conversation: updatedConv.state,
            };
          }

          return updateActiveConv(p, { messages: capped });
        }),
      ),

    removeLastConversationMessage: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          return updateActiveConv(p, { messages: conv.messages.slice(0, -1) });
        }),
      ),

    removeConversationMessageById: (projectId, messageId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          return updateActiveConv(p, { messages: conv.messages.filter((m) => m.id !== messageId) });
        }),
      ),

    updateMessageContent: (projectId, messageId, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = conv.messages.map((m) =>
            m.id === messageId ? { ...m, content } : m,
          );
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    updateMessageReasoning: (projectId, messageId, reasoning) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = conv.messages.map((m) =>
            m.id === messageId ? { ...m, reasoning_content: reasoning } : m,
          );
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    updateLastAssistantContent: (projectId, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            msgs[msgs.length - 1] = { ...last, content };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    appendToLastAssistantText: (projectId, text) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === "text") {
              blocks[blocks.length - 1] = {
                ...lastBlock,
                text: (lastBlock as { type: "text"; text: string }).text + text,
              };
            } else {
              blocks.push({ type: "text", text });
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    appendToLastAssistantThinking: (projectId, thinking) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === "thinking") {
              blocks[blocks.length - 1] = {
                ...lastBlock,
                thinking:
                  (lastBlock as { type: "thinking"; thinking: string })
                    .thinking + thinking,
              };
            } else {
              blocks.push({ type: "thinking", thinking });
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    setLastThinkingSignature: (projectId, signature) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            for (let i = blocks.length - 1; i >= 0; i--) {
              const block = blocks[i]!;
              if (block.type === "thinking") {
                blocks[i] = { ...block, signature };
                break;
              }
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    setConversationModel: (projectId, model) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { model }),
        ),
      ),

    setConversationStatusMessage: (projectId, message) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { statusMessage: message }),
        ),
      ),

    setConversationRoutedModel: (projectId, model) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { routedModel: model }),
        ),
      ),

    setConversationRestored: (projectId, isRestored) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { isRestored }),
        ),
      ),

    setConversationProcessing: (projectId, isProcessing) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { isProcessing }),
        ),
      ),

    setConversationError: (projectId, error) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { error }),
        ),
      ),

    setLastMessageStreamingDone: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last) {
            msgs[msgs.length - 1] = { ...last, isStreaming: false };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    // Stamps isStreaming: false on every message that's still streaming.
    finalizeAllStreaming: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const hasAny = conv.messages.some((m) => m.isStreaming);
          if (!hasAny) return {};
          const msgs = conv.messages.map((m) =>
            m.isStreaming ? { ...m, isStreaming: false } : m,
          );
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    setLastAssistantMeta: (projectId, costUsd, durationMs, inputTokens, outputTokens, numTurns) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.type === "assistant") {
              msgs[i] = {
                ...msgs[i]!,
                costUsd, durationMs, inputTokens, outputTokens, numTurns,
              };
              break;
            }
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    setLastAssistantVerdict: (projectId, verdict) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.type === "assistant") {
              msgs[i] = { ...msgs[i]!, verdict };
              break;
            }
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    clearConversation: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const empty = createEmptyConversation();
          return updateActiveConv(p, empty);
        }),
      ),

    clearSessionContext: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, {
            todos: [],
            isPlanning: false,
            phase: "idle",
            isProcessing: false,
          }),
        ),
      ),

    setHasUnreadCompletion: (projectId, hasUnread) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          hasUnreadCompletion: hasUnread,
        })),
      ),

    setHasUnreadLens: (projectId, hasUnread) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          hasUnreadLens: hasUnread,
        })),
      ),

    setConversationTodos: (projectId, todos) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { todos }),
        ),
      ),

    setPendingInput: (projectId, pendingInput) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { pendingInput }),
        ),
      ),

    clearPendingInput: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { pendingInput: null }),
        ),
      ),

    setIsPlanning: (projectId, isPlanning) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { isPlanning }),
        ),
      ),

    setConversationPhase: (projectId, phase) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { phase }),
        ),
      ),

    setStreamingConvId: (projectId, conversationId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          streamingConvId: conversationId ?? undefined,
        })),
      ),

    updateLastToolUseInput: (projectId, input) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i]!.type === "tool_use") {
                blocks[i] = { ...blocks[i]!, input } as ToolUseBlock;
                break;
              }
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return updateActiveConv(p, { messages: msgs });
        }),
      ),

    updateConversation: (projectId, conversationId, partial) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          directUpdateConv(p, conversationId, partial),
        ),
      ),

    updateToolUseInputById: (projectId, toolId, input) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          const msgs = [...conv.messages];
          for (let mi = msgs.length - 1; mi >= 0; mi--) {
            const msg = msgs[mi]!;
            if (msg.type === "assistant") {
              const blocks = [...msg.content];
              for (let i = 0; i < blocks.length; i++) {
                if (
                  blocks[i]!.type === "tool_use" &&
                  (blocks[i] as ToolUseBlock).id === toolId
                ) {
                  blocks[i] = { ...blocks[i]!, input } as ToolUseBlock;
                  msgs[mi] = { ...msg, content: blocks };
                  return updateActiveConv(p, { messages: msgs });
                }
              }
            }
          }
          return updateActiveConv(p, { messages: conv.messages });
        }),
      ),

    setContextPressure: (projectId, tokens, pressure) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { contextTokens: tokens, contextPressure: pressure }),
        ),
      ),

    setCompactionStatus: (projectId, status) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = getActiveConv(p);
          return updateActiveConv(p, {
            isCompacting: status.isCompacting ?? conv.isCompacting,
            lastCompactionAt: status.lastCompactionAt ?? conv.lastCompactionAt,
            compactionCount: status.compactionCount ?? conv.compactionCount,
            tokensSaved: status.tokensSaved ?? conv.tokensSaved,
          });
        }),
      ),

    setCachedBrief: (projectId, brief) =>
      set((state) =>
        updateProject(state, projectId, (p) =>
          updateActiveConv(p, { cachedBrief: brief }),
        ),
      ),

    restoreConversation: (projectId, messages, historyInfo, conversationId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const targetId = conversationId ?? p.activeConversationId;
          if (!targetId) return {};
          const conv = p.conversations.get(targetId);
          if (!conv) return {};
          const updated: Conversation = {
            ...conv,
            state: {
              ...conv.state,
              messages: messages.map((m) => ({ ...m, isHistorical: true })),
              model: null,
              routedModel: null,
              serviceTier: null,
              isProcessing: false,
              isPlanning: false,
              phase: "idle",
              isRestored: true,
              error: null,
              todos: [],
              isProcessActive: false,
              lastActivity: Date.now(),
              contextTokens: 0,
              contextPressure: "none",
              cachedBrief: "",
              statusMessage: null,
              isCompacting: false,
              lastCompactionAt: null,
              compactionCount: 0,
              tokensSaved: 0,
              historyTotalCount: historyInfo?.totalCount ?? 0,
              historyStartIndex: historyInfo?.startIndex ?? 0,
              pendingInput: null,
            },
            updatedAt: Date.now(),
          };
          const next = new Map(p.conversations);
          next.set(targetId, updated);
          return {
            conversations: next,
            conversation: targetId === p.activeConversationId ? updated.state : p.conversation,
          };
        }),
      ),

    prependOlderMessages: (projectId, olderMessages, newStartIndex, conversationId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const targetId = conversationId ?? p.activeConversationId;
          if (!targetId) return {};
          const conv = p.conversations.get(targetId);
          if (!conv) return {};
          const merged = [
            ...olderMessages.map((m) => ({ ...m, isHistorical: true })),
            ...conv.state.messages,
          ];
          const trimmed = merged.length > MAX_STORE_MESSAGES
            ? merged.length - MAX_STORE_MESSAGES
            : 0;
          const capped = trimmed > 0
            ? merged.slice(trimmed)
            : merged;
          const updated: Conversation = {
            ...conv,
            state: { ...conv.state, messages: capped, historyStartIndex: newStartIndex + trimmed },
            updatedAt: Date.now(),
          };
          const next = new Map(p.conversations);
          next.set(targetId, updated);
          return {
            conversations: next,
            conversation: targetId === p.activeConversationId ? updated.state : p.conversation,
          };
        }),
      ),

    // Terminal tabs
    addTerminalTab: (projectId, tab) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: [...p.terminalTabs, tab],
          activeTerminalTabId: tab.id,
        })),
      ),

    removeTerminalTab: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const tabs = p.terminalTabs.filter((t) => t.id !== tabId);
          let activeId = p.activeTerminalTabId;
          if (activeId === tabId) {
            activeId = tabs.length > 0 ? tabs[tabs.length - 1]!.id : null;
          }
          return { terminalTabs: tabs, activeTerminalTabId: activeId };
        }),
      ),

    setActiveTerminalTab: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          activeTerminalTabId: tabId,
        })),
      ),

    markTerminalTabDead: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: p.terminalTabs.map((t) =>
            t.id === tabId ? { ...t, isAlive: false } : t,
          ),
        })),
      ),

    updateTerminalTabCwd: (projectId, tabId, cwd) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: p.terminalTabs.map((t) =>
            t.id === tabId ? { ...t, cwd } : t,
          ),
        })),
      ),

    // Per-project routing
    setProjectPowerCombo: (projectId, combo) =>
      set((state) =>
        updateProject(state, projectId, () => ({ powerCombo: combo })),
      ),

    setProjectAutoEscalate: (projectId, autoEscalate) =>
      set((state) =>
        updateProject(state, projectId, () => ({ autoEscalate })),
      ),

    setProjectSelectedModel: (projectId, model, thinking, provider) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          selectedModel: model,
          selectedModelThinking: thinking,
          selectedModelProvider: provider,
        })),
      ),

    getProjectEffectiveCombo: (projectId) => {
      const state = get();
      const project = state.projects.get(projectId);
      if (project?.powerCombo) return project.powerCombo;
      // Fall back to workspace store's global combo
      return useWorkspaceStore.getState().powerCombo || DEFAULT_POWER_COMBO;
    },

    setThreadActivity: (projectId, fields) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          lastUserPromptText: fields.lastUserPromptText ?? state.projects.get(projectId)?.lastUserPromptText ?? null,
          lastResponseSummary: fields.lastResponseSummary ?? state.projects.get(projectId)?.lastResponseSummary ?? null,
          lastActivityAt: fields.lastActivityAt ?? state.projects.get(projectId)?.lastActivityAt ?? null,
        })),
      ),

    // Checkpoints
    addCheckpoint: (projectId, meta) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          checkpoints: [...p.checkpoints, meta],
        })),
      ),

    setCheckpoints: (projectId, checkpoints) =>
      set((state) => updateProject(state, projectId, () => ({ checkpoints }))),

    clearCheckpoints: (projectId) =>
      set((state) =>
        updateProject(state, projectId, () => ({ checkpoints: [] })),
      ),
  }));
}

interface ViteHotContext {
  data: Record<string, unknown>;
}
interface ViteImportMeta {
  hot?: ViteHotContext;
}

// Preserve store across HMR — prevents state loss and stale subscriptions
export const useProjectsStore: ReturnType<typeof createProjectsStore> =
  ((import.meta as unknown as ViteImportMeta).hot?.data?.__PROJECTS_STORE__ as ReturnType<typeof createProjectsStore> | undefined) ??
  (() => {
    const store = createProjectsStore();
    if ((import.meta as unknown as ViteImportMeta).hot) {
      (import.meta as unknown as ViteImportMeta).hot!.data.__PROJECTS_STORE__ = store;
    }
    return store;
  })();
